import { llmGateway } from '@workspace/llm';
import { createLogger } from '@workspace/logger';
import { z } from 'zod';

import {
  reflectionDistillationSchema,
  type ReflectionDistillation,
} from './reflection.js';

/**
 * The distiller writes a memory that will live in the corpus as durable
 * knowledge, so it runs on the same corrected-tuned model as the hygiene
 * judge and the rule distiller (independent of the cheap extraction model).
 */
const DEFAULT_MODEL = 'claude-sonnet-5';
const MAX_OUTPUT_TOKENS = 1024;
const DISTILL_TOOL_NAME = 'record_reflection_distillation';

const DISTILL_POLICY = `
You review a CLUSTER of related episode memories from one project scope —
session logs, checkpoints, and observations that tell one evolving story.
Decide whether they consolidate into ONE worthwhile living fact, and if so,
write that fact.

A worthwhile consolidation captures the STANDING outcome of the story: the
state that remains true now, the durable lesson, or the settled convention —
not the play-by-play. Answer consolidate=false when the episodes are only
loosely related, when each is a distinct fact worth keeping separate, or when
the story's outcome is already obsolete.

When consolidate=true, write content as the finished memory:
- self-contained — a reader without this conversation must understand it;
- present the CURRENT state first, with the trajectory in one clause when it
  prevents misreading; the newest episodes carry the latest truth, so when
  episodes disagree the later one wins;
- keep code, identifiers, paths, and quoted domain terms verbatim;
- a single paragraph, no headings, no preamble, no episode-by-episode replay.

Pick kind by content: "convention" when the consolidated statement is a
standing working agreement or practice; "fact" otherwise. Set confidence to
your genuine certainty; use a low value when unsure, so only clear cases
reach the review queue. Keep the rationale to one sentence.

Fill EVERY field of the tool call, including on a negative verdict: with
consolidate=false, set content to an empty string and still provide kind,
confidence, and the one-sentence rationale.`.trim();

/** One episode of the cluster, chronological. */
export interface ClusterEpisode {
  id: string;
  content: string;
  createdAt: string;
}

export interface ReflectionDistillerJudgement {
  verdict: ReflectionDistillation;
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
 * Model-backed adapter that distills one episode cluster into a consolidated
 * memory draft. Same forced-tool-use shape as the hygiene judge; the client
 * is created lazily so the server boots without an API key when reflection
 * is not run.
 */
export class ReflectionDistiller {
  readonly #logger = createLogger('ReflectionDistiller');

  async distill(
    scope: string,
    episodes: ClusterEpisode[],
    ownerId?: string
  ): Promise<ReflectionDistillerJudgement> {
    const model = process.env.ZM_HYGIENE_MODEL ?? DEFAULT_MODEL;
    const episodeBlock = episodes
      .map(
        (episode, index) =>
          `${index + 1}. [${episode.createdAt.slice(0, 10)}] ${episode.content}`
      )
      .join('\n');
    const response = await llmGateway().callTool({
      model,
      maxOutputTokens: MAX_OUTPUT_TOKENS,
      system: DISTILL_POLICY,
      prompt:
        `Episode cluster (scope ${scope}, chronological):\n` + episodeBlock,
      tool: {
        name: DISTILL_TOOL_NAME,
        description:
          'Record whether the episode cluster consolidates into one fact.',
        inputSchema: z.toJSONSchema(reflectionDistillationSchema, {
          target: 'draft-7',
        }) as Record<string, unknown>,
      },
      purpose: 'reflection',
      ...(ownerId === undefined ? {} : { subjectId: ownerId }),
    });

    const verdict = reflectionDistillationSchema.parse(response.input);
    this.#logger.debug('cluster distilled', {
      episodes: episodes.length,
      consolidate: verdict.consolidate,
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
