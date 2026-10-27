import { createLogger, runDetached } from '@workspace/logger';

import type { UsageEvent } from './usage-event.js';
import type { IUsageRecorder } from './usage-recorder.js';

const logger = createLogger('usage');

/**
 * Fire-and-forget emit: the write is deliberately not awaited, and a failed
 * one is logged at warn and dropped. Metering must never break — or even
 * slow — the operation it measures, so every emit point goes through here
 * rather than awaiting `recorder.record` directly.
 */
export const recordUsage = (
  recorder: IUsageRecorder,
  event: UsageEvent
): void =>
  runDetached(
    () => recorder.record(event),
    logger,
    'failed to record usage event',
    { eventType: event.eventType }
  );
