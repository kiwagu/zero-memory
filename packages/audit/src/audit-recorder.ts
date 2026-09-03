import type { AuditEvent } from './audit-event.js';

/**
 * Port: append one audit-log entry. Implementations resolve the actor (`usr_`),
 * request id, and author kind from the ambient execution context and write
 * through a privileged client, because public.audit_log is deny-all to end
 * users.
 *
 * `record` MAY reject; callers MUST NOT await it in a command's critical path.
 * Use {@link recordAudit} for the fire-and-forget contract.
 */
export interface IAuditRecorder {
  record(event: AuditEvent): Promise<void>;
}
