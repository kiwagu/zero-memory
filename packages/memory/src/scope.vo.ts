import { ValueObject } from '@workspace/domain';
import { Err, Ok, type Result } from 'oxide.ts';

/** ltree-compatible path: lowercase labels of [a-z0-9_] joined by dots. */
export const SCOPE_PATH_PATTERN = /^[a-z0-9_]+(\.[a-z0-9_]+)*$/;

const PERSONAL_ROOT = 'user';
const PROJECT_ROOT = 'proj';
const TEAM_ROOT = 'team';
const CORE_LABEL = 'core';

/**
 * Roots a caller-supplied scope may live under. A bare ltree label (agents
 * write `scope: "ulearn"`, or placeholder literals like `user` / `project`)
 * passes the pattern but lands OUTSIDE every read set — the memory becomes
 * invisible to normal recall — so creation requires a rooted path of at
 * least two labels.
 */
const SCOPE_ROOTS: ReadonlySet<string> = new Set([
  PERSONAL_ROOT,
  PROJECT_ROOT,
  TEAM_ROOT,
]);

const scopeHint = (path: string): string =>
  `Invalid scope "${path}": a scope is a rooted ltree path — ` +
  `"proj.<owner>.<slug>" (project), "user.<id>" (personal), ` +
  `"team.<owner>.<slug>" (team) — or the "core" shorthand. To store into ` +
  `the current project's scope, omit "scope" entirely (session default).`;

// ltree labels allow only [a-z0-9_], so fold both uuid hyphens and the dot in
// an entity id (`usr_<rand>.<ts>`) to underscores. A user's personal scope is
// therefore `user.usr_<rand>_<ts>` — one label, matching private.personal_scope().
const normalizeLabel = (raw: string): string =>
  raw.toLowerCase().replace(/[-.]/g, '_');

/**
 * Scope of a memory: an ltree path such as `user.<uid>` or
 * `proj.<owner_uid>.acme`.
 */
export class Scope extends ValueObject<string> {
  private constructor(path: string) {
    super({ value: path });
  }

  static create(path: string): Result<Scope, string> {
    if (!SCOPE_PATH_PATTERN.test(path)) {
      return Err(
        `Invalid scope "${path}": expected dot-separated [a-z0-9_] labels.`
      );
    }
    const labels = path.split('.');
    const root = labels[0] ?? '';
    if (!SCOPE_ROOTS.has(root) || labels.length < 2) {
      return Err(scopeHint(path));
    }
    return Ok(new Scope(path));
  }

  /**
   * Reconstitutes a scope from a STORED row (memories, project bindings).
   * Lenient on purpose: rows written before creation was hardened may carry a
   * legacy unrooted path (e.g. a bare `ulearn`), and a read must never fail
   * on data that is already in the store — only the ltree pattern is checked.
   * New scopes always go through the strict {@link create}.
   */
  static fromStored(path: string): Result<Scope, string> {
    if (!SCOPE_PATH_PATTERN.test(path)) {
      return Err(
        `Invalid stored scope "${path}": expected dot-separated [a-z0-9_] labels.`
      );
    }
    return Ok(new Scope(path));
  }

  /** Personal scope of a user, e.g. `user.6f9a..` (uuid hyphens -> `_`). */
  static user(userId: string): Scope {
    return new Scope(`${PERSONAL_ROOT}.${normalizeLabel(userId)}`);
  }

  /**
   * Personal core scope of a user (`user.<uid>.core`): the home of PORTABLE
   * knowledge — facts about tools and technologies that hold outside any one
   * project. Part of the default read set of every session, so a portable
   * gotcha follows the user across projects. Rows here stay private (owner
   * RLS admits private rows in any scope), so no scope membership is needed.
   */
  static core(userId: string): Scope {
    return new Scope(
      `${PERSONAL_ROOT}.${normalizeLabel(userId)}.${CORE_LABEL}`
    );
  }

  /**
   * Project scope, e.g. `proj.usr_ab12_01k.zero_memory`.
   *
   * Namespaced per OWNER: the second label is the creating user's entity id,
   * so two users of one pooled database whose projects derive the same
   * slug (e.g. both have a repo named `api`) land in SEPARATE scopes
   * (`proj.<A>.api` vs `proj.<B>.api`) instead of colliding on a global
   * `proj.api`. A name coincidence therefore never grants shared access:
   * collaboration on one project is an explicit membership act, never an
   * automatic consequence of a matching slug. Kept inside the shareable
   * `proj.*` tree (not the private personal subtree) so members can still be
   * added for team sharing.
   */
  static project(ownerId: string, slug: string): Scope {
    return new Scope(
      `${PROJECT_ROOT}.${normalizeLabel(ownerId)}.${normalizeLabel(slug)}`
    );
  }

  get path(): string {
    return this.props.value;
  }

  /** Last label of the path — the project slug for `proj.…` scopes. */
  get slug(): string {
    return this.props.value.split('.').at(-1) ?? this.props.value;
  }

  /**
   * A legacy 2-label project scope (`proj.<slug>`) — the pre-per-owner
   * generation. Agents copy such names out of old memories' scope fields, so
   * caller-supplied legacy paths are canonicalized to the caller's own
   * `proj.<owner>.<slug>` instead of forking the project across generations.
   */
  get isLegacyProject(): boolean {
    const labels = this.props.value.split('.');
    return labels[0] === PROJECT_ROOT && labels.length === 2;
  }

  /** A personal scope (`user.*`) — private to one user. */
  get isPersonal(): boolean {
    return this.props.value.startsWith(`${PERSONAL_ROOT}.`);
  }

  /** A shared scope (`proj.*` / `team.*`) whose members can see shared memory. */
  get isShareable(): boolean {
    return !this.isPersonal;
  }
}
