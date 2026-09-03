import { singleton } from '@workspace/di';
import { injectLlmGateway, type ILlmGateway } from '@workspace/llm';
import { createLogger } from '@workspace/logger';
import {
  injectUsageRecorder,
  recordUsage,
  type IUsageRecorder,
} from '@workspace/usage';
import { z } from 'zod';

import type { IUsefulnessJudge, RecalledFact } from './usefulness-judge.js';
import {
  usefulnessVerdictsSchema,
  type UsefulnessVerdict,
} from './usefulness-judge.schema.js';

const DEFAULT_MODEL = 'claude-haiku-4-5-20251001';
const MAX_OUTPUT_TOKENS = 1024;
const RECORD_TOOL_NAME = 'record_usefulness';

const JUDGE_POLICY = `
You judge each memory a coding agent was shown, on two independent axes.

You are given a transcript excerpt (the agent's work) and a numbered list of
memories that a recall surfaced to the agent just before that work. For EACH
memory decide:

1. useful — did the agent's subsequent work actually rely on it: cite it,
   fold it into a decision, follow the convention, or visibly change course
   because of it? Mere topical overlap is NOT use; the memory must have shaped
   the work. A memory the agent ignored is useful=false.
2. relevant — was the memory at least on-topic for what the session was
   doing, even if the agent never used it? An off-topic surfacing (wrong
   project, unrelated concern) is relevant=false. useful=true implies
   relevant=true.
3. misled — did the memory actively point the agent the WRONG way: the agent
   FOLLOWED it and the transcript then shows it was wrong, stale, or had to
   be corrected (a stored fix that failed, a decision reality contradicted,
   an explicit "that memory was outdated"). misled=true implies useful=false.
   Being unused or off-topic is NOT misled — default to misled=false unless
   the transcript shows the agent acting on the memory and paying for it.

Return one verdict per memory (same mem_id): useful true/false, relevant
true/false, misled true/false, and a confidence 0..1 for that call. Be
strict: default to useful=false when the transcript gives no clear evidence
of use.`.trim();

/**
 * Model-backed adapter for the usefulness-judge port: one forced-tool-use call on
 * a cheap model (mirrors the extractor's shape). The judge is a verifier, not a
 * writer — it only classifies ids already shown, and never emits memory
 * content. The call goes through the shared gateway rather than a client of
 * its own, which is what puts this spend somewhere it can be observed.
 */
@singleton()
export class LlmUsefulnessJudge implements IUsefulnessJudge {
  readonly #logger = createLogger(LlmUsefulnessJudge.name);

  constructor(
    @injectUsageRecorder()
    private readonly usage: IUsageRecorder,
    @injectLlmGateway()
    private readonly llm: ILlmGateway
  ) {}

  async judge(
    transcript: string,
    facts: RecalledFact[]
  ): Promise<UsefulnessVerdict[]> {
    if (facts.length === 0) {
      return [];
    }
    const model = process.env.ZM_JUDGE_MODEL ?? DEFAULT_MODEL;
    const prompt = [
      'Memories shown to the agent:',
      ...facts.map(
        (fact, index) => `${index + 1}. [${fact.id}] ${fact.content}`
      ),
      '',
      'Transcript excerpt (the agent work that followed):',
      transcript,
    ].join('\n');

    const response = await this.llm.callTool({
      model,
      maxOutputTokens: MAX_OUTPUT_TOKENS,
      system: JUDGE_POLICY,
      prompt,
      tool: {
        name: RECORD_TOOL_NAME,
        description:
          'Record one verdict per shown memory (same mem_id): useful, ' +
          'relevant, misled, confidence.',
        inputSchema: z.toJSONSchema(usefulnessVerdictsSchema, {
          target: 'draft-7',
        }) as Record<string, unknown>,
      },
      purpose: 'usefulness_judge',
    });

    // Judge tokens are a real ZM cost — meter them as extraction volume, tagged
    // by purpose so per-user cost separates the judge from ingest extraction.
    // Fire-and-forget: a metering failure never breaks the judge.
    recordUsage(this.usage, {
      eventType: 'llm_extraction',
      quantity: response.inputTokens + response.outputTokens,
      unit: 'tokens',
      metadata: {
        input_tokens: response.inputTokens,
        output_tokens: response.outputTokens,
        // Marks spend the platform never paid for, so the rollup can leave it
        // out. Without it, tokens bought with someone's own key would count
        // against them once that key is withdrawn.
        ...(response.ranOnCallerKey ? { own_key: true } : {}),
        model,
        purpose: 'usefulness_judge',
      },
    });

    const parsed = usefulnessVerdictsSchema.safeParse(response.input);
    if (!parsed.success) {
      this.#logger.warn('judge returned an unparseable payload', {
        error: parsed.error.message,
      });
      return [];
    }
    // Keep only verdicts for ids we actually asked about (the model can echo a
    // stray id); the caller further limits emits to the recalled set.
    const asked = new Set(facts.map((fact) => fact.id));
    return (
      parsed.data.verdicts
        .filter((verdict) => asked.has(verdict.mem_id))
        // misled implies useful=false by definition; enforce it here so one
        // inconsistent verdict cannot count as BOTH boost and demotion.
        .map((verdict) =>
          verdict.misled === true ? { ...verdict, useful: false } : verdict
        )
    );
  }
}
