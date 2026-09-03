import { singleton } from '@workspace/di';
import { createLogger } from '@workspace/logger';
import type { IPortabilityJudge, PortabilityOpinion } from '@workspace/memory';
import { createServiceRoleClient, type Client } from '@workspace/persistence';

import { HygieneJudge } from './hygiene-judge.js';

/** Metering agent of the write-time gate — distinct from the nightly audit. */
const AGENT_NAME = 'portability-gate';

/**
 * Adapter for the write-time portability port: the SAME judgement the nightly
 * audit runs, moved to the moment of the write.
 *
 * The audit asks "should this project fact be promoted to core?" and files a
 * reviewable proposal. Here the question is asked in the other direction and
 * answered immediately, because the write is happening now and the owner's
 * rule is that the project is the default: a claim of portability has to be
 * confirmed before it moves a fact out of the project it was learned in.
 *
 * FAIL-CLOSED BY CONSTRUCTION. Everything that can go wrong with a model call
 * — no key, a timeout, a malformed verdict — surfaces as `portable: false`
 * with the reason, so the caller routes the write to the project. A judge that
 * cannot answer must never be the reason a fact leaves its project.
 */
@singleton()
export class LlmWritePortabilityJudge implements IPortabilityJudge {
  readonly #logger = createLogger(LlmWritePortabilityJudge.name);

  // Collaborators are created lazily rather than injected. The container
  // resolves constructor parameters BY TYPE, and `Client` is a type alias for
  // the Supabase client — not something it can construct — so a defaulted
  // parameter here fails the whole graph at boot ("TypeInfo not known for
  // Object"). Lazily is also cheaper: a deployment that never denies a
  // portable-layer request never builds either collaborator.
  #judge?: HygieneJudge;
  #client?: Client;

  get #hygieneJudge(): HygieneJudge {
    this.#judge ??= new HygieneJudge();
    return this.#judge;
  }

  get #serviceRole(): Client {
    this.#client ??= createServiceRoleClient();
    return this.#client;
  }

  async judgePortability(
    kind: string,
    content: string,
    ownerId?: string
  ): Promise<PortabilityOpinion> {
    try {
      const judgement = await this.#hygieneJudge.judgePortability(
        // The judge reads kind + content; the id only rides its debug log, and
        // a prospective write has none yet.
        { id: 'pending', kind, content },
        ownerId
      );
      await this.#meter(judgement, ownerId);
      return {
        portable: judgement.verdict.portable,
        confidence: judgement.verdict.confidence,
        rationale: judgement.verdict.rationale,
      };
    } catch (error) {
      this.#logger.warn('write-time portability judgement failed', {
        error: String(error),
      });
      return {
        portable: false,
        confidence: 0,
        rationale: 'portability could not be judged',
      };
    }
  }

  /** Best-effort spend attribution; a metering failure never fails a write. */
  async #meter(
    judgement: {
      model: string;
      inputTokens: number;
      outputTokens: number;
      ranOnCallerKey: boolean;
    },
    ownerId?: string
  ): Promise<void> {
    if (judgement.inputTokens + judgement.outputTokens === 0) {
      return;
    }
    const { error } = await this.#serviceRole.from('usage_events').insert({
      event_type: 'llm_extraction',
      user_id: ownerId ?? null,
      quantity: judgement.inputTokens + judgement.outputTokens,
      unit: 'tokens',
      agent_name: AGENT_NAME,
      metadata: {
        purpose: 'portability_gate',
        model: judgement.model,
        input_tokens: judgement.inputTokens,
        output_tokens: judgement.outputTokens,
        ...(judgement.ranOnCallerKey ? { own_key: true } : {}),
      },
    });
    if (error) {
      this.#logger.warn('portability gate: metering failed', {
        error: error.message,
      });
    }
  }
}
