import { injectContext, type IContext } from '@workspace/context';
import { singleton } from '@workspace/di';
import {
  Scope,
  type ISessionThreadRepository,
  type SessionThread,
} from '@workspace/memory';
import { Err, None, Ok, Some, type Option, type Result } from 'oxide.ts';
import { z } from 'zod';

import { createServiceRoleClient, type Client } from '../supabase.client.js';

/** How long a thread keeps attaching before it must be re-asserted. */
const THREAD_TTL_MS = 24 * 60 * 60 * 1000;

const threadRowSchema = z.object({
  id: z.string(),
  conversation_id: z.string(),
  scope_path: z.string(),
});

/**
 * Supabase adapter for the session-thread port.
 *
 * Runs SERVICE-ROLE deliberately, unlike the project-binding adapter next to
 * it: the table is server-only (deny-all RLS, no end-user grants) because it
 * is operational state rather than user data. The safety RLS would have given
 * is kept explicitly — every read and write filters on the CALLER's own owner
 * id from the execution context, so a token or conversation id belonging to
 * someone else can never resolve. That is what makes the token a state
 * selector rather than a credential.
 */
@singleton()
export class SupabaseSessionThreadRepository implements ISessionThreadRepository {
  constructor(
    @injectContext()
    private readonly context: IContext
  ) {}

  async open(
    conversationId: string,
    scope: Scope
  ): Promise<Result<SessionThread, string>> {
    const now = Date.now();
    const { data, error } = await this.#client()
      .from('session_threads')
      .upsert(
        {
          owner_id: this.context.mustGetCurrentUserEntityId(),
          conversation_id: conversationId,
          scope_path: scope.path,
          last_seen_at: new Date(now).toISOString(),
          expires_at: new Date(now + THREAD_TTL_MS).toISOString(),
        },
        { onConflict: 'owner_id,conversation_id' }
      )
      .select('id, conversation_id, scope_path')
      .single();
    if (error) {
      return Err(
        `Failed to open the thread of conversation ${conversationId}: ${error.message}`
      );
    }
    const thread = this.#toThread(threadRowSchema.parse(data));
    return thread.isErr() ? Err(thread.unwrapErr()) : Ok(thread.unwrap());
  }

  async findByToken(token: string): Promise<Option<SessionThread>> {
    return this.#findLive('id', token);
  }

  async findByConversation(
    conversationId: string
  ): Promise<Option<SessionThread>> {
    return this.#findLive('conversation_id', conversationId);
  }

  /**
   * One live-row lookup for both legs. `expires_at` is compared here rather
   * than trusted from a sweep: a lapsed thread must stop attaching the moment
   * it lapses, whether or not anything has cleaned it up yet.
   */
  async #findLive(
    column: 'id' | 'conversation_id',
    value: string
  ): Promise<Option<SessionThread>> {
    const { data, error } = await this.#client()
      .from('session_threads')
      .select('id, conversation_id, scope_path')
      .eq('owner_id', this.context.mustGetCurrentUserEntityId())
      .eq(column, value)
      .gt('expires_at', new Date().toISOString())
      .maybeSingle();
    if (error) {
      throw new Error(
        `Failed to look up session thread (${column}): ${error.message}`
      );
    }
    if (!data) {
      return None;
    }
    const thread = this.#toThread(threadRowSchema.parse(data));
    // A row whose scope no longer parses is corrupt state, not a reason to
    // fail the caller's read: treat it as no thread.
    return thread.isErr() ? None : Some(thread.unwrap());
  }

  #toThread(
    row: z.infer<typeof threadRowSchema>
  ): Result<SessionThread, string> {
    const scope = Scope.fromStored(row.scope_path);
    if (scope.isErr()) {
      return Err(
        `Session thread ${row.id} holds an invalid scope: ${scope.unwrapErr()}`
      );
    }
    return Ok({
      token: row.id,
      conversationId: row.conversation_id,
      scope: scope.unwrap(),
    });
  }

  #client(): Client {
    return createServiceRoleClient();
  }
}
