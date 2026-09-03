import { WebSearchUnavailableError } from '@workspace/llm';
import { createLogger } from '@workspace/logger';
import { createServiceRoleClient, type Client } from '@workspace/persistence';

import {
  DEFAULT_REVERIFY_CONFIG,
  clearsReverifyGate,
  type ReverifyConfig,
} from './reverification.js';
import { ReverifyJudge, type ReverifyJudgement } from './reverify-judge.js';

export interface ReverifyScanResult {
  /** Due fast-layer memories the rollup returned. */
  candidates: number;
  /** Checks that confirmed the memory and stamped the ledger. */
  current: number;
  /** Checks that raised a review-queue dispute (never auto-superseded). */
  outdated: number;
  /** Checks the web could not settle — stamped as unverifiable. */
  unverifiable: number;
  /** Inconclusive checks (low confidence / cut off): nothing recorded. */
  inconclusive: number;
  /** Memories skipped because the owner's provider has no web search. */
  skippedUnsupported: number;
}

/** One row of the find_reverify_candidates rollup. */
type CandidateRow = {
  memory_id: string;
  owner_id: string;
  kind: string;
  content: string;
  last_verified_at: string | null;
};

const AGENT_NAME = 'reverify';

/**
 * Server-side, service-role external re-verification (the 4th hygiene
 * detector). Bounded by construction: the SQL rollup picks at most
 * `maxCandidates` due core-scope fact/reference memories (per-kind TTL, no
 * open dispute, most-reinforced first), and each check spends at most
 * `maxSearches` server-side web searches on the corpus owner's allowance.
 *
 * Honest by construction: a verdict must clear the confidence gate before
 * anything is recorded; an owner whose resolved provider has no server-side
 * web search is skipped AND audited as skipped — never stamped as checked.
 * `outdated` raises the same single-subject review dispute the challenge /
 * stale-suspect machinery already resolves; retirement stays a triage
 * decision.
 */
export class ReverifyDetector {
  readonly #logger = createLogger('ReverifyDetector');

  constructor(
    private readonly client: Client = createServiceRoleClient(),
    private readonly judge: ReverifyJudge = new ReverifyJudge(),
    private readonly config: ReverifyConfig = DEFAULT_REVERIFY_CONFIG
  ) {}

  async detect(): Promise<ReverifyScanResult> {
    const result: ReverifyScanResult = {
      candidates: 0,
      current: 0,
      outdated: 0,
      unverifiable: 0,
      inconclusive: 0,
      skippedUnsupported: 0,
    };

    const { data, error } = await this.client.rpc('find_reverify_candidates', {
      p_ttl_fact_days: this.config.ttlFactDays,
      p_ttl_reference_days: this.config.ttlReferenceDays,
      p_limit: this.config.maxCandidates,
    });
    if (error) {
      throw new Error(`reverify: rollup failed: ${error.message}`);
    }
    const rows = (data ?? []) as CandidateRow[];
    result.candidates = rows.length;

    // Owners whose resolved provider cannot web-search this run: skip their
    // remaining rows without more failed calls, and audit the skip once.
    const unsupportedOwners = new Set<string>();

    for (const row of rows) {
      if (unsupportedOwners.has(row.owner_id)) {
        result.skippedUnsupported += 1;
        continue;
      }

      let judgement: ReverifyJudgement;
      try {
        judgement = await this.judge.check(
          { id: row.memory_id, kind: row.kind, content: row.content },
          row.owner_id,
          this.config.maxSearches
        );
      } catch (error) {
        if (error instanceof WebSearchUnavailableError) {
          // The missing check must LOOK missing: no verification row is
          // written, the memory stays due, and the skip itself is recorded.
          unsupportedOwners.add(row.owner_id);
          result.skippedUnsupported += 1;
          await this.#audit('reverify.skip_unsupported', {
            owner_id: row.owner_id,
            provider: error.provider,
          });
          this.#logger.info('reverify: owner skipped, no web search', {
            owner: row.owner_id,
            provider: error.provider,
          });
          continue;
        }
        throw error;
      }
      await this.#meter(judgement, row.owner_id);

      if (!clearsReverifyGate(judgement.verdict, this.config.minConfidence)) {
        // Inconclusive concludes nothing: no stamp, no dispute — the memory
        // stays due and a later run retries with fresher search results.
        result.inconclusive += 1;
        await this.#audit('reverify.inconclusive', {
          memory_id: row.memory_id,
          verdict: judgement.verdict.verdict,
          confidence: judgement.verdict.confidence,
          model: judgement.model,
        });
        continue;
      }

      switch (judgement.verdict.verdict) {
        case 'current':
          await this.#stamp(row.memory_id, 'current', judgement.model);
          result.current += 1;
          await this.#audit('reverify.current', {
            memory_id: row.memory_id,
            confidence: judgement.verdict.confidence,
            sources: judgement.sources.length,
            model: judgement.model,
          });
          break;

        case 'outdated':
          await this.#dispute(row.memory_id, judgement);
          result.outdated += 1;
          await this.#audit('reverify.outdated', {
            memory_id: row.memory_id,
            confidence: judgement.verdict.confidence,
            source: judgement.verdict.source_url,
            model: judgement.model,
          });
          break;

        case 'unverifiable':
          // Stamped so the TTL does not retry a fact the web cannot settle
          // every night; the ledger records exactly that outcome.
          await this.#stamp(row.memory_id, 'unverifiable', judgement.model);
          result.unverifiable += 1;
          await this.#audit('reverify.unverifiable', {
            memory_id: row.memory_id,
            confidence: judgement.verdict.confidence,
            model: judgement.model,
          });
          break;
      }
    }

    this.#logger.info('reverify detection complete', { ...result });
    return result;
  }

  /** Stamp the freshness ledger (insert or refresh, counting the check). */
  async #stamp(
    memoryId: string,
    verdict: 'current' | 'unverifiable',
    model: string
  ): Promise<void> {
    const now = new Date().toISOString();
    const { data: existing, error: readError } = await this.client
      .from('memory_verification')
      .select('checks')
      .eq('memory_id', memoryId)
      .maybeSingle();
    if (readError) {
      throw new Error(
        `reverify: ledger read for ${memoryId} failed: ${readError.message}`
      );
    }
    const { error } = await this.client.from('memory_verification').upsert(
      {
        memory_id: memoryId,
        last_verified_at: now,
        verdict,
        verified_by_model: model,
        checks: (existing?.checks ?? 0) + 1,
        updated_at: now,
      },
      { onConflict: 'memory_id' }
    );
    if (error) {
      throw new Error(
        `reverify: stamp for ${memoryId} failed: ${error.message}`
      );
    }
  }

  /**
   * An outdated fact becomes a single-subject review dispute — the same
   * class the challenge / stale-suspect machinery already triages. The
   * verification row is deliberately NOT stamped: it stays at its previous
   * verdict until the dispute is resolved.
   */
  async #dispute(
    memoryId: string,
    judgement: ReverifyJudgement
  ): Promise<void> {
    const what =
      judgement.verdict.what_changed.trim() || judgement.verdict.rationale;
    const source = judgement.verdict.source_url.trim();
    const { error } = await this.client.from('memory_review_queue').insert({
      memory_a: memoryId,
      memory_b: null,
      verdict: 'stale_suspect',
      confidence: judgement.verdict.confidence,
      rationale:
        `External re-check found this outdated: ${what}` +
        (source === '' ? '' : ` (source: ${source})`),
    });
    if (error) {
      // 23505 = an open dispute already asks this question; nothing to add.
      if (error.code === '23505') {
        return;
      }
      throw new Error(
        `reverify: dispute for ${memoryId} failed: ${error.message}`
      );
    }
  }

  /** Meter one check's tokens — both legs, one purpose (best-effort). */
  async #meter(judgement: ReverifyJudgement, ownerId: string): Promise<void> {
    const { error } = await this.client.from('usage_events').insert({
      event_type: 'llm_extraction',
      // Whose work this is: upkeep of a corpus is done for its owner, so
      // it lands on their ledger and their allowance, not the instance's.
      user_id: ownerId,
      quantity: judgement.inputTokens + judgement.outputTokens,
      unit: 'tokens',
      agent_name: AGENT_NAME,
      metadata: {
        purpose: 'reverification',
        model: judgement.model,
        input_tokens: judgement.inputTokens,
        output_tokens: judgement.outputTokens,
        ...(judgement.ranOnCallerKey ? { own_key: true } : {}),
      },
    });
    if (error) {
      this.#logger.warn('reverify: metering failed', { error: error.message });
    }
  }

  async #audit(
    command: string,
    payload: Record<string, string | number>
  ): Promise<void> {
    const { error } = await this.client.from('audit_log').insert({
      command,
      payload,
      outcome: 'ok',
      author_kind: 'agent',
      agent_name: AGENT_NAME,
    });
    if (error) {
      // Audit is best-effort context, not the operation itself: log and move on.
      this.#logger.warn('reverify: audit write failed', {
        command,
        error: error.message,
      });
    }
  }
}
