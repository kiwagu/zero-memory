import { injectContext, type IContext } from '@workspace/context';
import { singleton } from '@workspace/di';
import type { IScopeMetaRepository, Scope } from '@workspace/memory';
import { Err, Ok, type Result } from 'oxide.ts';

import { createUserClient, type Client } from '../supabase.client.js';

/**
 * Supabase adapter for the scope metadata write port. Runs as the calling
 * user, so RLS on public.scopes (admin-only writes) is the enforcement
 * boundary. The upsert touches only the description columns — a stored
 * alias survives a model-written description untouched.
 */
@singleton()
export class SupabaseScopeMetaRepository implements IScopeMetaRepository {
  constructor(
    @injectContext()
    private readonly context: IContext
  ) {}

  async upsertModelDescription(
    scope: Scope,
    description: string
  ): Promise<Result<void, string>> {
    const { error } = await this.#client().from('scopes').upsert(
      {
        scope: scope.path,
        description,
        description_source: 'model',
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'scope' }
    );
    if (error) {
      return Err(`scope meta upsert failed: ${error.message}`);
    }
    return Ok(undefined);
  }

  #client(): Client {
    const accessToken = this.context.getAccessToken();
    if (!accessToken) {
      throw new Error('No access token in the execution context.');
    }
    return createUserClient(accessToken);
  }
}
