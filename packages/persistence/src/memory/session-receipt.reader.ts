import { injectContext, type IContext } from '@workspace/context';
import {
  sessionReceiptOutputSchema,
  type SessionReceiptOutput,
} from '@workspace/contracts';
import { singleton } from '@workspace/di';
import { type ISessionReceiptReader } from '@workspace/memory';

import { createUserClient, type Client } from '../supabase.client.js';

/**
 * Supabase adapter for the session-receipt read port: one call to the
 * `session_receipt` RPC (security definer, keyed on the current user inside
 * the function — usage_events stays deny-all).
 */
@singleton()
export class SupabaseSessionReceiptReader implements ISessionReceiptReader {
  constructor(
    @injectContext()
    private readonly context: IContext
  ) {}

  async read(since: string): Promise<SessionReceiptOutput> {
    const { data, error } = await this.#client().rpc('session_receipt', {
      p_since: since,
    });
    if (error) {
      throw new Error(`session_receipt failed: ${error.message}`);
    }
    return sessionReceiptOutputSchema.parse(data);
  }

  #client(): Client {
    const accessToken = this.context.getAccessToken();
    if (!accessToken) {
      throw new Error('No access token in the execution context.');
    }
    return createUserClient(accessToken);
  }
}
