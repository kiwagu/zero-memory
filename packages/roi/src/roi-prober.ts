import { llmGateway } from '@workspace/llm';
import { createLogger } from '@workspace/logger';
import { z } from 'zod';

import { roiProbeDraftsSchema, type RoiProbeDraft } from './roi.schema.js';

const DEFAULT_MODEL = 'claude-haiku-4-5-20251001';
const MAX_OUTPUT_TOKENS = 2048;
const PROBES_TOOL_NAME = 'record_probes';

const PROBER_POLICY = `
You build a holdout benchmark for a coding agent's memory system.

You are given stored memories (project decisions, gotchas, conventions). For
EACH memory, write ONE question that this memory — and realistically only this
memory — answers. The question must be natural (how the owner would ask it
mid-work), must NOT quote the memory verbatim, and must NOT contain the
answer. Skip nothing: one probe per memory, same memory_id.`.trim();

/** A memory eligible to become a probe's ground truth. */
export interface ProbeSourceMemory {
  id: string;
  content: string;
}

export interface RoiProberResult {
  probes: RoiProbeDraft[];
  model: string;
  inputTokens: number;
  outputTokens: number;
  /**
   * True when the call ran on the corpus owner's own key, so metering can
   * keep that spend out of the platform's ledger.
   */
  ranOnCallerKey: boolean;
}

export interface IRoiProber {
  generate(
    memories: ProbeSourceMemory[],
    ownerId?: string
  ): Promise<RoiProberResult>;
}

/**
 * Model-backed adapter: one forced-tool call turns a batch of owned memories
 * into holdout questions (mirrors the extractor's shape). Lazy client so
 * key-free deployments boot with the deterministic prober.
 */
export class LlmRoiProber implements IRoiProber {
  readonly #logger = createLogger(LlmRoiProber.name);

  async generate(
    memories: ProbeSourceMemory[],
    ownerId?: string
  ): Promise<RoiProberResult> {
    if (memories.length === 0) {
      return {
        probes: [],
        model: 'none',
        inputTokens: 0,
        outputTokens: 0,
        ranOnCallerKey: false,
      };
    }
    const model =
      process.env.ZM_ROI_MODEL ??
      process.env.ZM_EXTRACTOR_MODEL ??
      DEFAULT_MODEL;
    const response = await llmGateway().callTool({
      model,
      maxOutputTokens: MAX_OUTPUT_TOKENS,
      system: PROBER_POLICY,
      prompt: memories
        .map((memory) => `[${memory.id}]\n${memory.content}`)
        .join('\n\n'),
      tool: {
        name: PROBES_TOOL_NAME,
        description: 'Record one probe question per memory (same memory_id).',
        inputSchema: z.toJSONSchema(roiProbeDraftsSchema, {
          target: 'draft-7',
        }) as Record<string, unknown>,
      },
      purpose: 'roi_prober',
      ...(ownerId === undefined ? {} : { subjectId: ownerId }),
    });

    const parsed = roiProbeDraftsSchema.safeParse(response.input);
    if (!parsed.success) {
      this.#logger.warn('prober returned an unparseable payload', {
        error: parsed.error.message,
      });
      return {
        probes: [],
        model,
        inputTokens: 0,
        outputTokens: 0,
        ranOnCallerKey: response.ranOnCallerKey,
      };
    }
    // Keep only probes for memories we actually offered (echo guard).
    const offered = new Set(memories.map((memory) => memory.id));
    return {
      probes: parsed.data.probes.filter((probe) =>
        offered.has(probe.memory_id)
      ),
      model,
      inputTokens: response.inputTokens,
      outputTokens: response.outputTokens,
      ranOnCallerKey: response.ranOnCallerKey,
    };
  }
}

/**
 * Deterministic prober for smoke/e2e (no API key): a template question built
 * from the memory's opening words — enough for recall to have a real chance
 * of surfacing the source memory, and fully reproducible.
 */
export class DeterministicRoiProber implements IRoiProber {
  generate(
    memories: ProbeSourceMemory[],
    _ownerId?: string
  ): Promise<RoiProberResult> {
    const probes = memories.map((memory) => ({
      memory_id: memory.id,
      question: `What does project memory say about: ${memory.content
        .split(/\s+/)
        .slice(0, 8)
        .join(' ')}?`,
    }));
    return Promise.resolve({
      probes,
      model: 'deterministic',
      inputTokens: 0,
      outputTokens: 0,
      ranOnCallerKey: false,
    });
  }
}
