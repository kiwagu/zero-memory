import { llmGateway } from '@workspace/llm';
import { createLogger } from '@workspace/logger';
import { z } from 'zod';

import {
  roiVerdictSchema,
  type RoiProbeCase,
  type RoiVerdict,
} from './roi.schema.js';

const DEFAULT_MODEL = 'claude-haiku-4-5-20251001';
const MAX_OUTPUT_TOKENS = 512;
const VERDICT_TOOL_NAME = 'record_roi_verdict';

const JUDGE_POLICY = `
You judge one benchmark question for a coding agent's memory system, on two
independent axes.

You are given a question, the GROUND TRUTH (the stored memory the question was
derived from), and the facts a real memory search surfaced for that question.

1. with_memory — do the SURFACED facts contain enough to answer the question
   correctly (consistent with the ground truth)? Judge only from the surfaced
   facts, not the ground truth itself.
2. without_memory — could a competent agent answer this question correctly
   WITHOUT any project-specific memory, from general public knowledge alone?
   Project decisions, local conventions, machine-specific gotchas: no.
   General programming knowledge: yes.

Return with_memory, without_memory, and a confidence 0..1. Be strict on
with_memory: partial or off-topic facts do not count as an answer.`.trim();

/** Judge result enriched with token usage for metering. */
export interface RoiJudgement {
  verdict: RoiVerdict;
  model: string;
  inputTokens: number;
  outputTokens: number;
  /**
   * True when the call ran on the corpus owner's own key, so metering can
   * keep that spend out of the platform's ledger.
   */
  ranOnCallerKey: boolean;
}

export interface IRoiJudge {
  judge(probe: RoiProbeCase, ownerId?: string): Promise<RoiJudgement>;
}

/**
 * Model-backed adapter for the ROI judge: one forced-tool call per probe on a
 * cheap model (mirrors the hygiene/usefulness judges). The client is created
 * lazily so key-free deployments boot fine with the deterministic judge.
 */
export class LlmRoiJudge implements IRoiJudge {
  readonly #logger = createLogger(LlmRoiJudge.name);

  async judge(probe: RoiProbeCase, ownerId?: string): Promise<RoiJudgement> {
    const model =
      process.env.ZM_ROI_MODEL ??
      process.env.ZM_EXTRACTOR_MODEL ??
      DEFAULT_MODEL;
    const surfaced =
      probe.surfaced.length > 0
        ? probe.surfaced
            .map((fact, index) => `${index + 1}. ${fact.content}`)
            .join('\n')
        : '(the search surfaced nothing)';
    const response = await llmGateway().callTool({
      model,
      maxOutputTokens: MAX_OUTPUT_TOKENS,
      system: JUDGE_POLICY,
      prompt:
        `Question:\n${probe.question}\n\n` +
        `Ground truth (the stored memory):\n${probe.groundTruth}\n\n` +
        `Facts the memory search surfaced:\n${surfaced}`,
      tool: {
        name: VERDICT_TOOL_NAME,
        description: 'Record the two-axis verdict for this probe.',
        inputSchema: z.toJSONSchema(roiVerdictSchema, {
          target: 'draft-7',
        }) as Record<string, unknown>,
      },
      purpose: 'roi_judge',
      ...(ownerId === undefined ? {} : { subjectId: ownerId }),
    });

    const verdict = roiVerdictSchema.parse(response.input);
    this.#logger.debug('probe judged', {
      probeId: probe.probeId,
      ...verdict,
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

/**
 * Deterministic ROI judge for smoke/e2e (no API key) — and an honest lower
 * bound: with_memory = the ground-truth memory itself was surfaced (pure
 * retrieval success); without_memory = false (holdout questions derive from
 * project-specific memories a bare agent cannot know).
 */
export class DeterministicRoiJudge implements IRoiJudge {
  judge(probe: RoiProbeCase, _ownerId?: string): Promise<RoiJudgement> {
    const withMemory = probe.surfaced.some(
      (fact) => fact.id === probe.groundTruthId
    );
    return Promise.resolve({
      verdict: {
        with_memory: withMemory,
        without_memory: false,
        confidence: 1,
      },
      model: 'deterministic',
      inputTokens: 0,
      outputTokens: 0,
      ranOnCallerKey: false,
    });
  }
}
