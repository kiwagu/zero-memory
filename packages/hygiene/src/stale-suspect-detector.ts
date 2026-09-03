import { createLogger } from '@workspace/logger';
import { createServiceRoleClient, type Client } from '@workspace/persistence';

/** Tuning knobs for one stale-suspect detection run. */
export interface StaleSuspectConfig {
  /** Qualifying misled signals required before a memory is flagged. */
  threshold: number;
  /** Misled-evidence lookback window. */
  windowDays: number;
}

export const DEFAULT_STALE_SUSPECT_CONFIG: StaleSuspectConfig = {
  threshold: 2,
  windowDays: 90,
};

export interface StaleSuspectResult {
  /** Memories over the threshold with no open single-subject dispute. */
  candidates: number;
  /** Review-queue rows written this run. */
  queued: number;
}

/** One row of the find_stale_suspects rollup. */
type SuspectRow = {
  memory_id: string;
  owner_id: string;
  misled_count: number;
  last_misled_at: string;
};

const AGENT_NAME = 'stale-suspect';

/**
 * Negative half of the usage-feedback loop: memories that repeatedly MISLED
 * their readers (explicit challenges, judge misled verdicts) are queued for
 * review as `stale_suspect` — never auto-invalidated; retirement stays a
 * triage decision. Runs alongside the reinforcement rollup (same triggers:
 * scheduler tick, scan_hygiene, dashboard scan). Free of LLM calls. The
 * re-queue guard (only evidence newer than the last resolution counts) and
 * the open-dispute exclusion both live in the SQL rollup.
 */
export class StaleSuspectDetector {
  readonly #logger = createLogger('StaleSuspectDetector');

  constructor(
    private readonly client: Client = createServiceRoleClient(),
    private readonly config: StaleSuspectConfig = DEFAULT_STALE_SUSPECT_CONFIG
  ) {}

  async detect(): Promise<StaleSuspectResult> {
    const { data, error } = await this.client.rpc('find_stale_suspects', {
      p_threshold: this.config.threshold,
      p_window_days: this.config.windowDays,
    });
    if (error) {
      throw new Error(`stale-suspect: rollup failed: ${error.message}`);
    }
    const suspects = (data ?? []) as SuspectRow[];

    let queued = 0;
    for (const suspect of suspects) {
      const { error: insertError } = await this.client
        .from('memory_review_queue')
        .insert({
          memory_a: suspect.memory_id,
          memory_b: null,
          verdict: 'stale_suspect',
          // Content-free evidence summary: counts and dates only.
          rationale:
            `${suspect.misled_count} misled signals in the last ` +
            `${this.config.windowDays} days (latest ${suspect.last_misled_at}).`,
        });
      if (insertError) {
        // 23505 = a concurrent run flagged it between rollup and insert; the
        // pending row already says everything this one would.
        if (insertError.code === '23505') {
          continue;
        }
        throw new Error(
          `stale-suspect: queue insert failed: ${insertError.message}`
        );
      }
      queued += 1;
    }

    const result: StaleSuspectResult = {
      candidates: suspects.length,
      queued,
    };
    await this.#audit(result);
    this.#logger.info('stale-suspect detection complete', { ...result });
    return result;
  }

  async #audit(result: StaleSuspectResult): Promise<void> {
    const { error } = await this.client.from('audit_log').insert({
      command: 'stale_suspect.detect',
      payload: { ...result },
      outcome: 'ok',
      author_kind: 'agent',
      agent_name: AGENT_NAME,
    });
    if (error) {
      // Audit is best-effort context, not the operation itself: log and move on.
      this.#logger.warn('stale-suspect: audit write failed', {
        error: error.message,
      });
    }
  }
}
