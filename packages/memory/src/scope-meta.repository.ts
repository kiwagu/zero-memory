import type { Result } from 'oxide.ts';

import type { Scope } from './scope.vo.js';

/**
 * Port: write side of the scope display metadata (public.scopes). Only the
 * model-written description goes through here — alias and human edits are
 * dashboard writes. RLS gates the upsert to scope admins.
 */
export interface IScopeMetaRepository {
  upsertModelDescription(
    scope: Scope,
    description: string
  ): Promise<Result<void, string>>;
}
