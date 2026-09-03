/** Whether the actor behind a command is a person or an autonomous agent. */
export type AuthorKind = 'human' | 'agent';

/** Terminal result of a command's execution. */
export type AuditOutcome = 'ok' | 'error';

/**
 * One audited command execution. The decorator supplies the intent-level facts
 * (which command, its sanitized payload, how it ended, how long it took); the
 * adapter stamps actor (`usr_`), request id, and author kind from the ambient
 * context. Payload is sanitized (string fields truncated, hard size cap) before
 * it ever reaches here — see `sanitizeCommandPayload`.
 */
export interface AuditEvent {
  /** Command class name, e.g. `RememberCommand`. */
  command: string;
  /** Sanitized command payload, or a truncation marker. */
  payload: Record<string, unknown> | null;
  outcome: AuditOutcome;
  /** Error message (no stack) when outcome is 'error', else null. */
  error?: string | null;
  /** Wall-clock duration of the wrapped execute, in milliseconds. */
  durationMs: number;
}
