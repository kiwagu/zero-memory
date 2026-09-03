import { createLogger } from '@workspace/logger';
import {
  createServiceRoleClient,
  readAllPages,
  type Client,
} from '@workspace/persistence';

import {
  computeMultiplier,
  DEFAULT_REINFORCEMENT_CONFIG,
  type ReinforcementConfig,
} from './reinforcement.js';

export interface ReinforcementRollupResult {
  /** Memories with any usefulness/promotion signal in the window. */
  signals: number;
  /** Multiplier rows written (boosts + demotions). */
  written: number;
  /** Stale rows removed (signal aged out of the window / rule revoked). */
  removed: number;
}

/** One row of the find_reinforcement_signals rollup. */
type SignalRow = {
  memory_id: string;
  owner_id: string;
  in_band_events: number;
  judge_confidence: number;
  misled_events: number;
  misled_confidence: number;
  last_used_at: string | null;
  promoted: boolean;
};

const AGENT_NAME = 'reinforcement';

/**
 * Server-side, service-role reinforcement rollup. Runs alongside the hygiene
 * scanner (same triggers: scheduler tick, scan_hygiene, dashboard scan):
 * reads the usefulness evidence, applies the multiplier curve, and rewrites
 * memory_reinforcement to exactly the memories that currently carry a
 * signal. Free of LLM calls — one RPC plus bounded writes.
 */
export class ReinforcementRollup {
  readonly #logger = createLogger('ReinforcementRollup');

  constructor(
    private readonly client: Client = createServiceRoleClient(),
    private readonly config: ReinforcementConfig = DEFAULT_REINFORCEMENT_CONFIG
  ) {}

  async rollup(): Promise<ReinforcementRollupResult> {
    const { data, error } = await this.client.rpc(
      'find_reinforcement_signals',
      { p_window_days: this.config.windowDays }
    );
    if (error) {
      throw new Error(`reinforcement: signal rollup failed: ${error.message}`);
    }
    const signals = (data ?? []) as SignalRow[];

    // Neutral rows (multiplier == 1 after the curve) are represented by row
    // ABSENCE, so the table stays exactly as large as the active signal set.
    const rows = signals.flatMap((signal) => {
      const multiplier = computeMultiplier(
        {
          inBandEvents: signal.in_band_events,
          judgeConfidence: signal.judge_confidence,
          misledEvents: signal.misled_events,
          misledConfidence: signal.misled_confidence,
          promoted: signal.promoted,
        },
        this.config
      );
      if (multiplier === 1) {
        return [];
      }
      return [
        {
          memory_id: signal.memory_id,
          multiplier,
          useful_events: signal.in_band_events,
          last_used_at: signal.last_used_at,
          updated_at: new Date().toISOString(),
        },
      ];
    });

    if (rows.length > 0) {
      const { error: upsertError } = await this.client
        .from('memory_reinforcement')
        .upsert(rows, { onConflict: 'memory_id' });
      if (upsertError) {
        throw new Error(
          `reinforcement: multiplier upsert failed: ${upsertError.message}`
        );
      }
    }

    // Drop rows whose signal disappeared (events aged out, rule revoked):
    // an absent row IS the neutral multiplier.
    const keep = new Set(rows.map((row) => row.memory_id));
    // Paged: this compares against EVERY stored row, so a capped read would
    // silently treat the rows past the cap as absent and leave them stale.
    const existing = await readAllPages(
      (from, to) =>
        this.client
          .from('memory_reinforcement')
          .select('memory_id')
          .order('memory_id', { ascending: true })
          .range(from, to),
      { label: 'reinforcement: stale-row read' }
    );
    const stale = existing
      .map((row) => row.memory_id)
      .filter((id) => !keep.has(id));
    if (stale.length > 0) {
      const { error: deleteError } = await this.client
        .from('memory_reinforcement')
        .delete()
        .in('memory_id', stale);
      if (deleteError) {
        throw new Error(
          `reinforcement: stale-row cleanup failed: ${deleteError.message}`
        );
      }
    }

    const result: ReinforcementRollupResult = {
      signals: signals.length,
      written: rows.length,
      removed: stale.length,
    };
    await this.#audit(result);
    this.#logger.info('reinforcement rollup complete', { ...result });
    return result;
  }

  async #audit(result: ReinforcementRollupResult): Promise<void> {
    const { error } = await this.client.from('audit_log').insert({
      command: 'reinforcement.rollup',
      payload: { ...result },
      outcome: 'ok',
      author_kind: 'agent',
      agent_name: AGENT_NAME,
    });
    if (error) {
      // Audit is best-effort context, not the operation itself: log and move on.
      this.#logger.warn('reinforcement: audit write failed', {
        error: error.message,
      });
    }
  }
}
