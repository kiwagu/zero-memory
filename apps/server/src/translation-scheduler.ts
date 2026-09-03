import { createLogger } from '@workspace/logger';
import { TranslationWorker } from '@workspace/translation';
import { container } from '@workspace/di';
import { LlmTranslator } from '@workspace/translation';
import { USAGE_RECORDER, type IUsageRecorder } from '@workspace/usage';
import { DeterministicTranslator } from '@workspace/translation/testing';

const logger = createLogger('translation-scheduler');

/**
 * Periodic language-canonicalization pass, run in-process on the server and
 * therefore independent of the (optional, Claude-Code-bound) watcher. Each tick
 * classifies not-yet-translated rows and drains the pending queue through the
 * translator.
 *
 * Opt-in: it only schedules when `ZM_TRANSLATION_SCAN_INTERVAL_HOURS` is a
 * positive number, so a fresh install never starts making translation (model)
 * calls until an operator asks for it — the same "run a dry run first" gate the
 * on-demand script gives. Ticks are non-overlapping and a failed pass is logged
 * and swallowed — translation must never take the serving process down.
 *
 * Returns a stop function (clears the timer) for tests and graceful shutdown;
 * returns null when disabled.
 */
export function startTranslationScheduler(): (() => void) | null {
  const raw = process.env.ZM_TRANSLATION_SCAN_INTERVAL_HOURS;
  const hours = Number(raw ?? 0);
  if (!Number.isFinite(hours) || hours <= 0) {
    logger.info('translation scheduler disabled', {
      hint: 'set ZM_TRANSLATION_SCAN_INTERVAL_HOURS to a positive number to enable',
    });
    return null;
  }

  const intervalMs = hours * 3_600_000;
  let running = false;

  const tick = async (): Promise<void> => {
    if (running) {
      logger.warn(
        'previous translation pass still running; skipping this tick'
      );
      return;
    }
    running = true;
    try {
      // The deterministic translator keeps key-free smoke stacks green; the
      // model-backed one is used everywhere else — the same switch the extractor
      // wiring uses.
      const translator =
        process.env.ZM_EXTRACTOR === 'deterministic'
          ? new DeterministicTranslator()
          : new LlmTranslator(
              // The scheduled pass builds its own translator, so the recorder
              // has to be handed over explicitly — otherwise this whole path
              // would run unmetered.
              container.resolve<IUsageRecorder>(USAGE_RECORDER)
            );
      const worker = new TranslationWorker(translator);
      const result = await worker.run();
      logger.info('scheduled translation pass complete', {
        ...result.classify,
        ...result.translate,
      });
    } catch (error) {
      logger.error('scheduled translation pass failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => void tick(), intervalMs);
  // Do not keep the process alive for the timer alone.
  (timer as { unref?: () => void }).unref?.();
  logger.info('translation scheduler started', { intervalHours: hours });

  return () => clearInterval(timer);
}
