import { injectContext, type IContext } from '@workspace/context';
import { singleton } from '@workspace/di';
import { createLogger } from '@workspace/logger';
import {
  Scope,
  type IScopeAccessService,
  type ProjectCandidate,
} from '@workspace/memory';
import { Err, Ok, type Result } from 'oxide.ts';

import { createUserClient, type Client } from '../supabase.client.js';

/**
 * Supabase adapter for the scope-access port: probes write access via the
 * `can_write_scope` RPC under the current user's JWT (security invoker, so
 * the answer is exactly what RLS would enforce). Fail-closed: any error is
 * treated as "no access". createScope wraps the `create_scope` bootstrap
 * RPC (security definer; validates roots and claims server-side).
 * listMemberProjects reads the caller's own accepted memberships and the
 * scopes' aliases — the same RLS-bound reads the dashboard's scopes page makes.
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

  async listMemberProjects(): Promise<Result<ProjectCandidate[], string>> {
    const client = this.#client();
    const me = this.context.mustGetCurrentUserEntityId();
    const { data: memberships, error } = await client
      .from('scope_members')
      .select('scope')
      .eq('user_id', me)
      .not('accepted_at', 'is', null);
    if (error) {
      return Err(`scope_members read failed: ${error.message}`);
    }
    // A project is a shared scope with an owner and a slug
    // (`proj.<owner>.<slug>`, `team.<owner>.<slug>`); a membership on a root
    // or on a personal scope names no project a person would type.
    const scopes = [
      ...new Set((memberships ?? []).map((row) => String(row.scope))),
    ]
      .sort()
      .flatMap((path) => {
        const scope = Scope.fromStored(path);
        return scope.isOk() &&
          scope.unwrap().isShareable &&
          path.split('.').length >= 3
          ? [scope.unwrap()]
          : [];
      });
    if (scopes.length === 0) {
      return Ok([]);
    }
    const { data: aliases, error: aliasError } = await client
      .from('scopes')
      .select('scope, alias')
      .not('alias', 'is', null);
    if (aliasError) {
      return Err(`scopes read failed: ${aliasError.message}`);
    }
    const aliasOf = new Map(
      (aliases ?? []).map((row) => [String(row.scope), row.alias])
    );
    // The caller's own project is exactly the scope a project of theirs with
    // that slug would have; anything else was shared with them by its owner.
    return Ok(
      scopes.map((scope) => ({
        scope,
        alias: aliasOf.get(scope.path) ?? null,
        own: Scope.project(me, scope.slug).path === scope.path,
      }))
    );
  }

  #client(): Client {
    const accessToken = this.context.getAccessToken();
    if (!accessToken) {
      throw new Error('No access token in the execution context.');
    }
    return createUserClient(accessToken);
  }
}
