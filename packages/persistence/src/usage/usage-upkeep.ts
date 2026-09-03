import { createLogger } from '@workspace/logger';

import { createServiceRoleClient, type Client } from '../supabase.client.js';

export interface UsageUpkeepResult {
  /** Monthly partitions of usage_events created on this run. */
  partitionsCreated: number;
  /** Rows written into the daily rollup. */
  daysWritten: number;
}

/**
 * How far ahead partitions are kept. Three months of headroom means the
 * ledger keeps accepting writes through a long outage of this job — the
 * default partition exists for the case beyond that, and is drained the
 * moment the job runs again.
 */
const MONTHS_AHEAD = 3;

/**
 * How much of the recent past the rollup recomputes each run. Judge verdicts
 * arrive out of band, days after the events they describe, so a rollup that
 * only ever wrote new days would freeze them before their evidence landed.
 */
const ROLLUP_WINDOW_DAYS = 7;

/**
 * Keeps the usage ledger's storage healthy: rolls the partition horizon
 * forward and refreshes the daily metric rollup.
 *
 * Both halves are plain SQL — no model calls, nothing to meter, nothing that
 * costs an operator money. That is why this runs unconditionally rather than
 * behind an opt-in interval like the hygiene and translation passes: those
 * gates exist to stop a fresh install from spending on LLM work, and applying
 * the same gate here would mean a default install silently stops extending
 * partitions and never materialises a metric.
 */
export class UsageUpkeep {
  readonly #logger = createLogger('UsageUpkeep');

  constructor(private readonly client: Client = createServiceRoleClient()) {}

  async run(): Promise<UsageUpkeepResult> {
    // Partitions first: the rollup reads the ledger, and a ledger that cannot
    // accept today's writes is the more urgent of the two problems.
    const partitions = await this.client.rpc('usage_events_ensure_partitions', {
      p_months_ahead: MONTHS_AHEAD,
    });
    if (partitions.error) {
      throw new Error(
        `Failed to ensure usage partitions: ${partitions.error.message}`
      );
    }

    const rollup = await this.client.rpc('usage_daily_rollup', {
      p_days: ROLLUP_WINDOW_DAYS,
    });
    if (rollup.error) {
      throw new Error(`Failed to roll up usage days: ${rollup.error.message}`);
    }

    const result: UsageUpkeepResult = {
      partitionsCreated: partitions.data ?? 0,
      daysWritten: rollup.data ?? 0,
    };

    // A created partition is worth a line: it is the one event here that
    // changes the shape of the database rather than its contents.
    if (result.partitionsCreated > 0) {
      this.#logger.info('usage partitions created', {
        count: result.partitionsCreated,
      });
    }

    return result;
  }
}
