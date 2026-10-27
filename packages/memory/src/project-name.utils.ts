import {
  projectHintUnresolvableMessage,
  type ProjectChoice,
} from '@workspace/contracts';

import { entityMatchKey } from './entity.do.js';
import type { Scope } from './scope.vo.js';

/** A project the caller belongs to, as a name can point at it. */
export interface ProjectCandidate {
  readonly scope: Scope;
  /** The short name an admin gave the project on the dashboard, if any. */
  readonly alias: string | null;
  /**
   * Whether the project is the caller's own (`proj.<caller>.<slug>`) rather
   * than one somebody else shared with them. Another owner's name or alias
   * must never quietly win over the caller's own project.
   */
  readonly own: boolean;
}

/** What a typed project name points at among the caller's projects. */
export type ProjectNameMatch =
  | { readonly kind: 'match'; readonly project: ProjectCandidate }
  | {
      readonly kind: 'ambiguous';
      readonly projects: readonly ProjectCandidate[];
    }
  | { readonly kind: 'unknown' };

/**
 * The initials of a multi-word name — `zero_memory`, `ZeroMemory` and
 * `Zero Memory` are all `zm` — or null for a one-word name, whose single
 * letter would match far too much to mean anything.
 */
const projectNameInitials = (name: string): string | null => {
  const words = name
    .trim()
    .replace(/([\p{Ll}\p{N}])(\p{Lu})/gu, '$1 $2')
    .split(/[\s_-]+/u)
    .filter((word) => word.length > 0);
  if (words.length < 2) {
    return null;
  }
  return words
    .map((word) => word[0])
    .join('')
    .toLowerCase();
};

const namesOf = (candidate: ProjectCandidate): string[] =>
  candidate.alias
    ? [candidate.scope.slug, candidate.alias]
    : [candidate.scope.slug];

const decide = (
  found: readonly ProjectCandidate[]
): ProjectNameMatch | null => {
  const distinct = found.filter(
    (candidate, index) =>
      found.findIndex((other) => other.scope.path === candidate.scope.path) ===
      index
  );
  if (distinct.length === 0) {
    return null;
  }
  return distinct.length === 1
    ? { kind: 'match', project: distinct[0]! }
    : { kind: 'ambiguous', projects: distinct };
};

/**
 * Finds the project a typed name means, among the caller's own projects and
 * the ones shared with them.
 *
 * Deterministic on purpose. The name is compared by the same spelling key
 * entities resolve by — lowercased, every run of spaces, `_` and `-` removed —
 * so `zero-memory`, `zero_memory`, `Zero Memory` and `ZeroMemory` are one
 * name; the project's own scope path and its dashboard alias count too. Only
 * when nothing matches by spelling are initials tried (`ZM` → `zero_memory`).
 * Similarity is not: short project names that differ by a letter are
 * different projects, and no threshold separates them from spelling variants.
 *
 * The first test that matches anything decides — unless it matched only
 * projects other people own while one of the caller's own projects fits the
 * name by any test. Another owner controls their project's name and alias,
 * so their `ZM` must not capture a name the caller meant for their own
 * `zero_memory` and carry the caller's work into a scope that owner reads;
 * both are offered instead.
 *
 * More than one project is `ambiguous` and none is `unknown` — both are for
 * the caller to settle, never for this function to guess.
 */
export const matchProjectName = (
  hint: string,
  candidates: readonly ProjectCandidate[]
): ProjectNameMatch => {
  const trimmed = hint.trim();
  const key = entityMatchKey(trimmed);
  if (key.length === 0) {
    return { kind: 'unknown' };
  }
  const tests: ((candidate: ProjectCandidate) => boolean)[] = [
    (c) => c.scope.path === trimmed,
    (c) => namesOf(c).some((name) => entityMatchKey(name) === key),
    (c) => namesOf(c).some((name) => projectNameInitials(name) === key),
  ];
  for (const test of tests) {
    const found = candidates.filter(test);
    if (found.length === 0) {
      continue;
    }
    const ownElsewhere = found.some((c) => c.own)
      ? []
      : candidates.filter((c) => c.own && tests.some((t) => t(c)));
    return decide([...found, ...ownElsewhere]) ?? { kind: 'unknown' };
  }
  return { kind: 'unknown' };
};

/**
 * Why a hint named no project a write can go to, and what the caller can
 * pick instead.
 */
export interface ProjectHintMiss {
  /**
   * `unknown`: a name that fits none of the caller's projects. `ambiguous`:
   * a name that fits several. `unroutable`: a path or remote that routes to
   * no project scope.
   */
  readonly reason: 'unknown' | 'ambiguous' | 'unroutable';
  /** The projects an ambiguous name fits; otherwise all of the caller's. */
  readonly projects: readonly ProjectCandidate[];
}

/** Projects as a refusal offers them: the name to pass back, and the scope. */
export const projectChoices = (
  projects: readonly ProjectCandidate[]
): ProjectChoice[] =>
  projects.map((project) => ({
    name: project.alias ?? project.scope.slug,
    scope: project.scope.path,
  }));

/** The refusal for a write whose hint named no project it can go to. */
export const projectHintMissMessage = (
  hint: string,
  miss: ProjectHintMiss,
  options: { readonly portableLayers?: boolean } = {}
): string =>
  projectHintUnresolvableMessage(hint, {
    reason: miss.reason,
    projects: projectChoices(miss.projects),
    portableLayers: options.portableLayers,
  });
