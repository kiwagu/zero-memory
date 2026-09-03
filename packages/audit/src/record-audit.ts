import { createLogger } from '@workspace/logger';

import type { AuditEvent } from './audit-event.js';
import type { IAuditRecorder } from './audit-recorder.js';

const logger = createLogger('audit');

/**
 * Fire-and-forget emit: the returned promise is deliberately not awaited, and a
 * failed write is logged at warn and dropped. Auditing must never break — or
 * change the outcome of — the command it records, so every audit point goes
 * through here rather than awaiting `recorder.record` directly.
 */
export const recordAudit = (
  recorder: IAuditRecorder,
  event: AuditEvent
): void => {
  // Wrapping in a resolved promise turns a synchronous throw from a misbehaving
  // adapter into a rejection the single catch handles.
  void Promise.resolve()
    .then(() => recorder.record(event))
    .catch((error: unknown) => {
      logger.warn('failed to record audit event', {
        command: event.command,
        outcome: event.outcome,
        error: error instanceof Error ? error.message : String(error),
      });
    });
};
