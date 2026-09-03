import { injectContext, type IContext } from '@workspace/context';
import { singleton } from '@workspace/di';
import { createLogger } from '@workspace/logger';
import type { IScopeAccessService, Scope } from '@workspace/memory';
import { Err, Ok, type Result } from 'oxide.ts';

import { createUserClient, type Client } from '../supabase.client.js';

/**
 * Supabase adapter for the scope-access port: probes write access via the
 * `can_write_scope` RPC under the current user's JWT (security invoker, so
 * the answer is exactly what RLS would enforce). Fail-closed: any error is
 * treated as "no access". createScope wraps the `create_scope` bootstrap
 * RPC (security definer; validates roots and claims server-side).
 */
@singleton()
export class SupabaseScopeAccessService implements IScopeAccessService {
  readonly #logger = createLogger(SupabaseScopeAccessService.name);

  constructor(
    @injectContext()
    private readonly context: IContext
  ) {}

  async canWrite(scope: Scope): Promise<boolean> {
    const { data, error } = await this.#client().rpc('can_write_scope', {
      p_scope: scope.path,
    });
    if (error) {
      this.#logger.warn('can_write_scope probe failed (fail-closed)', {
        scope: scope.path,
        error: error.message,
      });
      return false;
    }
    return data === true;
  }

  async createScope(scope: Scope): Promise<Result<void, string>> {
    const { error } = await this.#client().rpc('create_scope', {
      p_scope: scope.path,
    });
    if (error) {
      return Err(`create_scope("${scope.path}") failed: ${error.message}`);
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
