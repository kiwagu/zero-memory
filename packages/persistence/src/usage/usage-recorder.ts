import {
  getCurrentSessionId,
  getRequestId,
  injectContext,
  type IContext,
} from '@workspace/context';
import type { Json } from '@workspace/db';
import { singleton } from '@workspace/di';
import type { IUsageRecorder, UsageEvent } from '@workspace/usage';

import { createServiceRoleClient, type Client } from '../supabase.client.js';

/**
 * Supabase adapter for the usage-recorder port. Appends to the deny-all
 * public.usage_events through the service-role client (end users have no RLS
 * grant), stamping the actor (`usr_`) and request id (`req_`) from the ambient
 * execution context. The privileged client is built lazily so a server without
 * a service-role key can still boot when metering is never exercised.
 */
@singleton()
export class SupabaseUsageRecorder implements IUsageRecorder {
  #client: Client | null = null;

  constructor(
    @injectContext()
    private readonly context: IContext
  ) {}

  async record(event: UsageEvent): Promise<void> {
    const { error } = await this.#serviceClient()
      .from('usage_events')
      .insert({
        // Explicit beats ambient: a background pass names its owner, and a
        // request-bound call has none to name.
        user_id:
          event.subjectId ?? this.context.getCurrentUserEntityId() ?? null,
        agent_name: event.agentName ?? null,
        event_type: event.eventType,
        quantity: event.quantity ?? 1,
        unit: event.unit ?? 'count',
        // Content-free structured counters; cast to the DB Json type (the port
        // uses a looser Record for ergonomics at the emit sites). The ambient
        // transport session id rides along as `mcp_session_id` so a session's
        // calls can be grouped after the fact (recall-gap analysis); omitted
        // outside a transport session so background rows stay clean.
        metadata: this.#withSessionId(event.metadata) as Json,
        request_id: getRequestId() ?? null,
      });
    if (error) {
      throw new Error(`Failed to record usage event: ${error.message}`);
    }
  }

  /**
   * Merge the ambient MCP transport session id into the event metadata as
   * `mcp_session_id`. Returns the metadata unchanged when there is no session
   * in context (background pass) so those rows carry no spurious grouping key.
   */
  #withSessionId(
    metadata: Record<string, unknown> | null | undefined
  ): Record<string, unknown> | null {
    const sessionId = getCurrentSessionId();
    if (!sessionId) {
      return metadata ?? null;
    }
    return { ...(metadata ?? {}), mcp_session_id: sessionId };
  }

  #serviceClient(): Client {
    this.#client ??= createServiceRoleClient();
    return this.#client;
  }
}
