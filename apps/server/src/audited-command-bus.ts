import {
  recordAudit,
  sanitizeCommandPayload,
  type IAuditRecorder,
} from '@workspace/audit';
import type { ICommandBus } from '@workspace/cqrs';
import type { Command } from '@workspace/domain';

/**
 * Composition-layer decorator that audits every command without touching the
 * generic command bus. It delegates to the wrapped bus and records one
 * audit_log entry per execution — timing the call, capturing the sanitized
 * payload, and marking outcome ok/error. The original exception is re-thrown
 * unchanged, and the audit write is fire-and-forget (a failed write never
 * breaks or slows the command). Queries do not pass through here, so they are
 * never audited — exactly as intended.
 */
export class AuditedCommandBus implements ICommandBus {
  constructor(
    private readonly inner: ICommandBus,
    private readonly audit: IAuditRecorder
  ) {}

  async execute<T extends Command, TResult = unknown>(
    command: T
  ): Promise<TResult> {
    const startedAt = performance.now();
    const commandName = command.constructor.name;
    try {
      const result = await this.inner.execute<T, TResult>(command);
      recordAudit(this.audit, {
        command: commandName,
        payload: sanitizeCommandPayload(command),
        outcome: 'ok',
        durationMs: Math.round(performance.now() - startedAt),
      });
      return result;
    } catch (error) {
      recordAudit(this.audit, {
        command: commandName,
        payload: sanitizeCommandPayload(command),
        outcome: 'error',
        error: error instanceof Error ? error.message : String(error),
        durationMs: Math.round(performance.now() - startedAt),
      });
      throw error;
    }
  }
}
