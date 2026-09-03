import { createLogger } from '@workspace/logger';

import type { UsageEvent } from './usage-event.js';
import type { IUsageRecorder } from './usage-recorder.js';

const logger = createLogger('usage');

/**
 * Fire-and-forget emit: the returned promise is deliberately not awaited, and a
 * failed write is logged at warn and dropped. Metering must never break — or
 * even slow — the operation it measures, so every emit point goes through here
 * rather than awaiting `recorder.record` directly.
 */
export const recordUsage = (
  recorder: IUsageRecorder,
  event: UsageEvent
): void => {
  // Wrapping the call in a resolved promise turns a synchronous throw from a
  // misbehaving adapter into a rejection the single catch handles — the emit
  // site can never blow up, whether record() throws or returns a rejection.
  void Promise.resolve()
    .then(() => recorder.record(event))
    .catch((error: unknown) => {
      logger.warn('failed to record usage event', {
        eventType: event.eventType,
        error: error instanceof Error ? error.message : String(error),
      });
    });
};
