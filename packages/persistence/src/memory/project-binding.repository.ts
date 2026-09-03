import { injectContext, type IContext } from '@workspace/context';
import { singleton } from '@workspace/di';
import {
  Scope,
  type IProjectBindingRepository,
  type ProjectBinding,
  type ProjectMatchKind,
} from '@workspace/memory';
import { Err, None, Ok, Some, type Option, type Result } from 'oxide.ts';
import { z } from 'zod';

import { createUserClient, type Client } from '../supabase.client.js';

const bindingRowSchema = z.object({
  scope: z.string(),
});

/**
 * Supabase adapter for the project-binding port. Reads and writes run as the
 * current user: RLS lets the creator and members of the bound scope read a
 * binding, and any authenticated user record one (a binding only names a
 * scope — memory access stays gated by the RLS on memories).
 */
@singleton()
export class SupabaseProjectBindingRepository implements IProjectBindingRepository {
  constructor(
    @injectContext()
    private readonly context: IContext
  ) {}

  async findScope(kind: ProjectMatchKind, key: string): Promise<Option<Scope>> {
    // Bindings are per-owner (unique on created_by + identity): a project
    // identity a teammate happens to share resolves to the CURRENT user's own
    // binding, never someone else's. RLS would also hide a foreign creator's
    // row, but filtering explicitly keeps the lookup deterministic when the
    // user is a member of another owner's bound scope.
    const { data, error } = await this.#client()
      .from('project_bindings')
      .select('scope')
      .eq('created_by', this.context.mustGetCurrentUserEntityId())
      .eq('match_kind', kind)
      .eq('match_key', key)
      .maybeSingle();
    if (error) {
      throw new Error(
        `Failed to look up project binding (${kind}, ${key}): ${error.message}`
      );
    }
    if (!data) {
      return None;
    }
    const row = bindingRowSchema.parse(data);
    const scope = Scope.fromStored(row.scope);
    if (scope.isErr()) {
      throw new Error(
        `Project binding (${kind}, ${key}) holds an invalid scope: ` +
          scope.unwrapErr()
      );
    }
    return Some(scope.unwrap());
  }

  async insert(binding: ProjectBinding): Promise<Result<void, string>> {
    // ignoreDuplicates -> ON CONFLICT DO NOTHING: a racing insert of the
    // same project identity is a success, whatever scope won the race. The
    // conflict target is the per-owner unique (created_by + identity), set
    // explicitly so the upsert resolves against the right constraint.
    const { error } = await this.#client().from('project_bindings').upsert(
      {
        created_by: this.context.mustGetCurrentUserEntityId(),
        match_kind: binding.kind,
        match_key: binding.key,
        scope: binding.scope.path,
      },
      { onConflict: 'created_by,match_kind,match_key', ignoreDuplicates: true }
    );
    if (error) {
      return Err(
        `Failed to insert project binding (${binding.kind}, ` +
          `${binding.key}): ${error.message}`
      );
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
