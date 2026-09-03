import { llmGateway } from '@workspace/llm';
import { createLogger } from '@workspace/logger';
import { z } from 'zod';

import {
  loopClosureVerdictSchema,
  type LoopClosureVerdict,
} from './loop-closure.js';

/**
 * Closing a loop mutates lifecycle state the owner relies on, so the judge
 * runs on the same corrected-tuned model as the hygiene judge and the
 * distillers (independent of the cheap extraction model).
 */
const DEFAULT_MODEL = 'claude-sonnet-5';
const MAX_OUTPUT_TOKENS = 512;
const VERDICT_TOOL_NAME = 'record_loop_closure_verdict';

const JUDGE_POLICY = `
You review one OPEN LOOP — a recorded task or open question that keeps
surfacing in an agent's briefings until closed — against newer memories from
the same owner (the candidate evidence). Decide whether the evidence asserts
that the loop's work is COMPLETE or its question is ANSWERED.

Answer closed=true ONLY when some evidence memory explicitly states the
outcome the loop asks for: the work merged/deployed/done, the question
resolved with its answer. The bar is an assertion of completion, not
relatedness:
- progress reports, partial milestones, or plans to do the work do NOT close;
- a memory that narrows, rewords, or hands over the SAME task does NOT close;
- when the loop lists several remaining steps, ALL of them must be asserted
  done — evidence covering only some steps does NOT close;
- a loop that by its own text closes on a condition (a date, an external
  event) does NOT close until evidence asserts that condition happened.

When closed=true, set evidence_id to the ONE memory that carries the
completion assertion. Set confidence to your genuine certainty; doubt means
a low value — a wrongly-closed task silently disappears from briefings,
which is worse than a lingering one.

Fill EVERY field of the tool call, including on a negative verdict: with
closed=false, set evidence_id to an empty string and still provide
confidence and the one-sentence rationale.`.trim();

/** One evidence memory, strongest-similarity first. */
export interface LoopEvidence {
  id: string;
  content: string;
  createdAt: string;
}

export interface LoopClosureJudgement {
  verdict: LoopClosureVerdict;
  model: string;
  inputTokens: number;
  outputTokens: number;
  /**
   * True when the call ran on the corpus owner's own key, so metering can
   * keep that spend out of the platform's ledger.
   */
  ranOnCallerKey: boolean;
}

/**
 * Model-backed adapter that judges one open loop against its evidence. Same
 * forced-tool-use shape as the hygiene judge; the client is created lazily
 * so the server boots without an API key when the detector is not run.
 */
export class LoopClosureJudge {
  readonly #logger = createLogger('LoopClosureJudge');

  async judge(
    loop: { content: string; createdAt: string },
    evidence: LoopEvidence[],
    ownerId?: string
  ): Promise<LoopClosureJudgement> {
    const model = process.env.ZM_HYGIENE_MODEL ?? DEFAULT_MODEL;
    const evidenceBlock = evidence
      .map(
        (memory) =>
          `- id ${memory.id} [${memory.createdAt.slice(0, 10)}]: ` +
          memory.content
      )
      .join('\n');
    const response = await llmGateway().callTool({
      model,
      maxOutputTokens: MAX_OUTPUT_TOKENS,
      system: JUDGE_POLICY,
      prompt:
        `Open loop [recorded ${loop.createdAt.slice(0, 10)}]:\n` +
        `${loop.content}\n\n` +
        `Candidate evidence (newer memories, strongest match first):\n` +
        evidenceBlock,
      tool: {
        name: VERDICT_TOOL_NAME,
        description:
          'Record whether the evidence asserts the open loop is complete.',
        inputSchema: z.toJSONSchema(loopClosureVerdictSchema, {
          target: 'draft-7',
        }) as Record<string, unknown>,
      },
      purpose: 'loop-closure',
      ...(ownerId === undefined ? {} : { subjectId: ownerId }),
    });

    const verdict = loopClosureVerdictSchema.parse(response.input);
    this.#logger.debug('loop judged', {
      closed: verdict.closed,
      confidence: verdict.confidence,
    });
    return {
      verdict,
      model,
      inputTokens: response.inputTokens,
      outputTokens: response.outputTokens,
      ranOnCallerKey: response.ranOnCallerKey,
    };
  }
}
