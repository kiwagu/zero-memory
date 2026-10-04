import type { Result } from 'oxide.ts';

import type { Scope } from './scope.vo.js';

/**
 * Port: write side of the scope display metadata (public.scopes). Only the
 * model-written description goes through here — alias and human edits are
 * dashboard writes. RLS gates the upsert to scope admins.
 */
export interface IScopeMetaRepository {
  /**
   * Whether the user administers the scope: an accepted admin membership of
   * it or of an ancestor. Asked before anything is spent on an admin-only
   * operation; the write itself stays gated by RLS.
   */
  isScopeAdmin(
    scope: Scope,
    userEntityId: string
  ): Promise<Result<boolean, string>>;

  upsertModelDescription(
    scope: Scope,
    description: string
  ): Promise<Result<void, string>>;
}
