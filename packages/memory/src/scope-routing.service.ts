import { injectContext, type IContext } from '@workspace/context';
import { singleton } from '@workspace/di';
import { createLogger } from '@workspace/logger';

import { injectProjectBindingRepository } from './project-binding.repository.provider.js';
import type { IProjectBindingRepository } from './project-binding.repository.js';
import { normalizeProjectHint } from './project-hint.vo.js';
import { injectScopeAccessService } from './scope-access.provider.js';
import type { IScopeAccessService } from './scope-access.service.js';
import { Scope } from './scope.vo.js';

/**
 * Routes a project identity (git remote or path) to the ltree scope its
 * auto-populated memories belong in:
 *
 *   normalize hint -> existing binding -> use its scope
 *   -> no binding: derive `proj.<slug>`; if the user cannot already write
 *      there, bootstrap it via create_scope; record the binding
 *   -> anything fails -> the caller's personal scope (fail-safe: memories
 *      are stored private, never lost and never leaked).
 *
 * Used by the ingestion pipeline and by the MCP roots handshake.
 */
@singleton()
export class ScopeRoutingService {
  readonly #logger = createLogger(ScopeRoutingService.name);

  constructor(
    @injectProjectBindingRepository()
    private readonly bindings: IProjectBindingRepository,
    @injectScopeAccessService()
    private readonly scopeAccess: IScopeAccessService,
    @injectContext()
    private readonly context: IContext
  ) {}

  /** Personal scope of the current user — the routing fallback. */
  personalScope(): Scope {
    return Scope.user(this.context.mustGetCurrentUserEntityId());
  }

  /**
   * Personal core scope of the current user — the home of PORTABLE knowledge
   * (facts that hold outside any one project); read by every session.
   */
  coreScope(): Scope {
    return Scope.core(this.context.mustGetCurrentUserEntityId());
  }

  /** Parses a session default scope, degrading to personal when invalid. */
  resolveDefaultScope(rawScope: string): Scope {
    const scope = Scope.create(rawScope);
    if (scope.isErr()) {
      this.#logger.warn('invalid default scope, using personal scope', {
        scope: rawScope,
        error: scope.unwrapErr(),
      });
      return this.personalScope();
    }
    return scope.unwrap();
  }

  /**
   * Resolves the scope for a raw project hint. Never throws for routing
   * reasons: every failure path degrades to the personal scope.
   */
  async resolveProjectScope(rawHint: string): Promise<Scope> {
    const normalized = normalizeProjectHint(rawHint);
    if (normalized.isErr()) {
      this.#logger.warn('project hint not normalizable, using personal scope', {
        hint: rawHint,
        error: normalized.unwrapErr(),
      });
      return this.personalScope();
    }
    const hint = normalized.unwrap();

    const bound = await this.bindings.findScope(hint.kind, hint.key);
    if (bound.isSome()) {
      return bound.unwrap();
    }

    // Project scopes are namespaced under the owner's entity id
    // (`proj.<owner>.<slug>`), so a slug shared with another user of a
    // pooled database never collides with theirs — first-sight onboarding
    // always succeeds instead of falling back to the personal scope.
    const scope = Scope.project(
      this.context.mustGetCurrentUserEntityId(),
      hint.slug
    );

    // First sight of this project: make sure the scope exists (writable by
    // this user) before binding to it. canWrite is true when the user is
    // already a writer/admin; otherwise create_scope bootstraps the scope
    // under the caller's own `proj.<owner>` root.
    const canWrite = await this.scopeAccess.canWrite(scope);
    if (!canWrite) {
      const created = await this.scopeAccess.createScope(scope);
      if (created.isErr()) {
        this.#logger.warn('scope bootstrap failed, using personal scope', {
          scope: scope.path,
          error: created.unwrapErr(),
        });
        return this.personalScope();
      }
    }

    const inserted = await this.bindings.insert({
      kind: hint.kind,
      key: hint.key,
      scope,
    });
    if (inserted.isErr()) {
      // Lost a race or RLS said no — the scope itself is still usable.
      this.#logger.warn('project binding insert failed', {
        key: hint.key,
        error: inserted.unwrapErr(),
      });
    }
    return scope;
  }
}
