import { createLogger } from '@workspace/logger';
import { UsageUpkeep } from '@workspace/persistence';

const logger = createLogger('usage-scheduler');

/** Hours between upkeep runs when the operator has not said otherwise. */
const DEFAULT_INTERVAL_HOURS = 24;

/**
 * One upkeep run: what each tick does, and what a deployment without a
 * long-running process (AWS Lambda) invokes on its own schedule. Throws when
 * the run fails; the caller decides whether that is fatal.
 */
export async function runUsageUpkeep(): Promise<void> {
  const result = await new UsageUpkeep().run();
  logger.info('usage upkeep complete', { ...result });
}

/**
 * Storage upkeep for the usage ledger: extends the monthly partition horizon
 * and refreshes the daily metric rollup.
 *
 * Unlike the hygiene and translation schedulers this one is ALWAYS ON. Those
 * are opt-in because each tick spends money on model calls; this one runs two
 * SQL functions. Gating it the same way would mean the common case — an
 * install that set no intervals — quietly stops extending partitions and
 * never materialises a day, which the dashboard would then report as a
 * flatline rather than as a stopped job.
 *
 * `ZM_USAGE_UPKEEP_INTERVAL_HOURS` tunes the cadence. The first run happens at
 * startup rather than one interval later, so a fresh deployment has its
 * partitions and its first rollup immediately.
 *
 * Ticks are non-overlapping and a failed run is logged and swallowed — upkeep
 * must never take the serving process down.
 */
export function startUsageScheduler(): () => void {
  const raw = process.env.ZM_USAGE_UPKEEP_INTERVAL_HOURS;
  const parsed = Number(raw ?? DEFAULT_INTERVAL_HOURS);
  const hours =
    Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_INTERVAL_HOURS;

  const intervalMs = hours * 3_600_000;
  let running = false;

  const tick = async (): Promise<void> => {
    if (running) {
      logger.warn('previous usage upkeep still running; skipping this tick');
      return;
    }
    running = true;
    try {
      await runUsageUpkeep();
    } catch (error) {
      logger.error('usage upkeep failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      running = false;
    }
  };

  void tick();
  const timer = setInterval(() => void tick(), intervalMs);
  // Upkeep is not a reason to hold the process open.
  timer.unref?.();

  logger.info('usage scheduler started', { intervalHours: hours });

  return () => clearInterval(timer);
}
