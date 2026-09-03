import { injectContext, type IContext } from '@workspace/context';
import {
  type DeleteAccountOutput,
  deleteAccountOutputSchema,
} from '@workspace/contracts';
import { singleton } from '@workspace/di';
import { type IAccountEraser } from '@workspace/memory';

import { createServiceRoleClient } from '../supabase.client.js';

/**
 * Supabase adapter for the account-erasure port. The subject is the
 * authenticated caller — resolved from the execution context, never taken from
 * the client — so this can only erase the caller's own account. The cascade
 * itself (`hard_delete_user`) is a service-role entry point: it spans every
 * user's rows past RLS and removes the auth principal, privileges no end user
 * holds, so this adapter runs it on a service-role client.
 */
@singleton()
export class SupabaseAccountEraser implements IAccountEraser {
  constructor(
    @injectContext()
    private readonly context: IContext
  ) {}

  async eraseCurrentAccount(): Promise<DeleteAccountOutput> {
    const subject = this.context.mustGetCurrentUserEntityId();
    const { data, error } = await createServiceRoleClient().rpc(
      'hard_delete_user',
      { p_user_id: subject }
    );
    if (error) {
      throw new Error(`Account erasure failed: ${error.message}`);
    }
    return deleteAccountOutputSchema.parse(data);
  }
}
