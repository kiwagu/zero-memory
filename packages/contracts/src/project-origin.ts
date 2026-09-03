/**
 * Provenance-derived project identity for cross-project pair filtering.
 *
 * One owner works on many projects, and after a bootstrap-import their
 * personal scope holds other projects' knowledge. Semantically-similar
 * memories from DIFFERENT projects are not conflicts (both are true in their
 * own project), and an LLM judge cannot tell them apart from content alone —
 * both monorepos may have the same packages/ui/components.json. Measured on
 * real pairs: prompting the judge with scope labels regressed true-supersedes
 * detection instead of fixing this. So project identity is resolved
 * DETERMINISTICALLY here, before any judge call or write-time hint:
 *   - a `proj.…` scope pins the memory to the project named by its LAST label
 *     (the slug). Two scope generations coexist after the per-owner namespace
 *     migration — legacy `proj.<slug>` and per-owner `proj.<owner>.<slug>` —
 *     and one real project may have rows in both, so identity is the slug,
 *     with the owner segment acting as a namespace: equal slugs under
 *     different owner segments are DIFFERENT projects, equal slugs otherwise
 *     are the SAME project across generations;
 *   - an imported memory (`source.kind === 'import'`) pins it to the project
 *     whose flattened directory appears in `source.path`
 *     (…/projects/<flattened-repo-path>/memory/…);
 *   - anything else (personal notes, no provenance) stays unknown and is
 *     paired as before.
 * A pair is skipped only when BOTH sides resolve and provably differ.
 *
 * Used by the hygiene scanner (post-write conflict pairing) and by
 * remember()'s supersede-candidate feedback (write-time hint) — the same
 * predicate keeps both from surfacing provably-different-project pairs.
 */

export interface OriginSide {
  scope: string;
  source: Record<string, unknown> | null;
}

/**
 * Project identity of a `proj.…` scope: the slug (last label) plus the owner
 * segment when the scope is a per-owner generation (`proj.<owner>.<slug>`,
 * 3+ labels). A legacy 2-label `proj.<slug>` has no owner segment — it
 * matches the same slug under ANY owner (one project's rows straddle the
 * generations, and hygiene pairing is same-owner anyway).
 */
interface ProjIdentity {
  owner: string | null;
  slug: string;
}

const projIdentity = (scope: string): ProjIdentity | null => {
  if (!scope.startsWith('proj.')) {
    return null;
  }
  const labels = scope.split('.').slice(1);
  const slug = labels.at(-1);
  if (!slug) {
    return null;
  }
  return { owner: labels.length > 1 ? (labels[0] ?? null) : null, slug };
};

const sameProject = (a: ProjIdentity, b: ProjIdentity): boolean =>
  a.slug === b.slug &&
  (a.owner === null || b.owner === null || a.owner === b.owner);

const importDir = (source: Record<string, unknown> | null): string | null => {
  if (!source || source['kind'] !== 'import') {
    return null;
  }
  const path = source['path'];
  if (typeof path !== 'string') {
    return null;
  }
  return /\/projects\/([^/]+)\//.exec(path)?.[1] ?? null;
};

// The flattened dir is the absolute repo path with '/' → '-', so the repo
// name sits at the end behind a '-' boundary. Scope names use '_' where the
// repo dir uses '-' (proj.zero_memory ↔ …-zero-memory).
const dirMatchesProject = (dir: string, name: string): boolean =>
  dir.endsWith(`-${name.replaceAll('_', '-')}`);

/**
 * True when the two memories provably belong to DIFFERENT projects — such a
 * pair is not a conflict and must not be judged, queued, or offered as a
 * supersede candidate. False whenever either side's project is unknown (the
 * pair proceeds as before).
 */
export function crossProjectPair(a: OriginSide, b: OriginSide): boolean {
  const pa = projIdentity(a.scope);
  const pb = projIdentity(b.scope);
  if (pa && pb) {
    return !sameProject(pa, pb);
  }
  const ia = importDir(a.source);
  const ib = importDir(b.source);
  if (ia && ib) {
    return ia !== ib;
  }
  if (pa && ib) {
    return !dirMatchesProject(ib, pa.slug);
  }
  if (pb && ia) {
    return !dirMatchesProject(ia, pb.slug);
  }
  return false;
}
