import type { AuditEvent, IAuditRecorder } from '@workspace/audit';
import { getRequestId, injectContext, type IContext } from '@workspace/context';
import type { Json } from '@workspace/db';
import { singleton } from '@workspace/di';

import { createServiceRoleClient, type Client } from '../supabase.client.js';

/**
 * Supabase adapter for the audit-recorder port. Appends to the deny-all
 * public.audit_log through the service-role client, stamping the actor (`usr_`)
 * and request id (`req_`) from the ambient execution context. author_kind is
 * fixed to 'agent': the command bus is exclusively the MCP write path (agent
 * principals) — the web dashboard mutates via direct Supabase server actions,
 * not commands. The privileged client is built lazily.
 */
@singleton()
export class SupabaseAuditRecorder implements IAuditRecorder {
  #client: Client | null = null;

  constructor(
    @injectContext()
    private readonly context: IContext
  ) {}

  async record(event: AuditEvent): Promise<void> {
    const { error } = await this.#serviceClient()
      .from('audit_log')
      .insert({
        actor_id: this.context.getCurrentUserEntityId() ?? null,
        author_kind: 'agent',
        agent_name: null,
        command: event.command,
        payload: (event.payload ?? null) as Json,
        outcome: event.outcome,
        error: event.error ?? null,
        duration_ms: event.durationMs,
        request_id: getRequestId() ?? null,
      });
    if (error) {
      throw new Error(`Failed to record audit event: ${error.message}`);
    }
  }

  #serviceClient(): Client {
    this.#client ??= createServiceRoleClient();
    return this.#client;
  }
}
