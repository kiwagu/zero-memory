import type { Result } from 'oxide.ts';

import type { Scope } from './scope.vo.js';

/**
 * Port: scope write-access checks and bootstrap for the current user.
 *
 * RLS remains the enforcement boundary in the database; this port exists so
 * the application layer can fail closed BEFORE mutating an aggregate (the
 * memories update policy admits the owner regardless of the target scope, so
 * sharing must be pre-validated here).
 */
export interface IScopeAccessService {
  /** True when the current user may write shared memories into `scope`. */
  canWrite(scope: Scope): Promise<boolean>;

  /**
   * Bootstraps a shared scope with the current user as its first admin.
   * Fails when the scope (or a related scope) already has members — the
   * caller decides whether that is fatal or a fallback trigger.
   */
  createScope(scope: Scope): Promise<Result<void, string>>;
}
