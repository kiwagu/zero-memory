import { injectContext, type IContext } from '@workspace/context';
import { singleton } from '@workspace/di';
import { createLogger } from '@workspace/logger';
import { Err, Ok, type Result } from 'oxide.ts';

import { injectProjectBindingRepository } from './project-binding.repository.provider.js';
import type { IProjectBindingRepository } from './project-binding.repository.js';
import { isProjectNameHint, normalizeProjectHint } from './project-hint.vo.js';
import {
  matchProjectName,
  type ProjectCandidate,
  type ProjectHintMiss,
} from './project-name.utils.js';
import { injectScopeAccessService } from './scope-access.provider.js';
import type { IScopeAccessService } from './scope-access.service.js';
import { Scope } from './scope.vo.js';

/**
 * Routes a project identity to the ltree scope its memories belong in.
 *
 * A path or a git remote is what a machine reports about a repository:
 *
 *   normalize hint -> existing binding -> use its scope
 *   -> no binding: derive `proj.<slug>`; if the user cannot already write
 *      there, bootstrap it via create_scope; record the binding
 *   -> anything fails -> the caller's personal scope (fail-safe: memories
 *      are stored private, never lost and never leaked).
 *
 * A NAME is what a person or an agent typed, and it only ever points at a
 * project that already exists: it is matched against the caller's own
 * projects ({@link matchProjectName}), and nothing is created or bound for
 * it. A name that fits no project, or several, degrades like any other
 * unroutable hint; {@link resolveProjectTarget} reports it with the projects
 * to choose from instead.
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
    if (isProjectNameHint(rawHint)) {
      const match = matchProjectName(rawHint, await this.listProjects());
      if (match.kind === 'match') {
        return match.project.scope;
      }
      this.#logger.warn('project name names no single project', {
        hint: rawHint,
        match: match.kind,
      });
      return this.personalScope();
    }
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

  /**
   * The project a write names by its hint, or why it names none. Unlike
   * {@link resolveProjectScope} nothing degrades here: a write that asked for
   * a project and cannot have one is refused, and the refusal carries the
   * projects the caller can pick from.
   */
  async resolveProjectTarget(
    rawHint: string
  ): Promise<Result<Scope, ProjectHintMiss>> {
    if (isProjectNameHint(rawHint)) {
      const projects = await this.listProjects();
      const match = matchProjectName(rawHint, projects);
      if (match.kind === 'match') {
        return Ok(match.project.scope);
      }
      return Err(
        match.kind === 'ambiguous'
          ? { reason: 'ambiguous', projects: match.projects }
          : { reason: 'unknown', projects }
      );
    }
    const scope = await this.resolveProjectScope(rawHint);
    if (scope.isShareable) {
      return Ok(scope);
    }
    return Err({ reason: 'unroutable', projects: await this.listProjects() });
  }

  /**
   * The projects the caller belongs to. An empty list when they cannot be
   * read: a name then matches nothing and is refused, which is the safe way
   * for this to fail.
   */
  async listProjects(): Promise<ProjectCandidate[]> {
    const listed = await this.scopeAccess.listMemberProjects();
    if (listed.isErr()) {
      this.#logger.warn('member projects could not be listed', {
        error: listed.unwrapErr(),
      });
      return [];
    }
    return listed.unwrap();
  }
}
