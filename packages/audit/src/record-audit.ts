import { createLogger, runDetached } from '@workspace/logger';

import type { AuditEvent } from './audit-event.js';
import type { IAuditRecorder } from './audit-recorder.js';

const logger = createLogger('audit');

/**
 * Fire-and-forget emit: the write is deliberately not awaited, and a failed
 * one is logged at warn and dropped. Auditing must never break — or change
 * the outcome of — the command it records, so every audit point goes through
 * here rather than awaiting `recorder.record` directly.
 */
export const recordAudit = (
  recorder: IAuditRecorder,
  event: AuditEvent
): void =>
  runDetached(
    () => recorder.record(event),
    logger,
    'failed to record audit event',
    { command: event.command, outcome: event.outcome }
  );
