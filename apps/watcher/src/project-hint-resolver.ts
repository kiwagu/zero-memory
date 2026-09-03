import { spawnSync } from 'node:child_process';
import { dirname } from 'node:path';

/**
 * Resolves a session's working directory to a STABLE PROJECT identity — the
 * OUTERMOST git repository that encloses it — so a session run in a
 * subdirectory, a linked worktree, or a nested private repo routes to the one
 * project rather than a phantom project named after the leaf directory.
 *
 * The server slugs the basename of whatever hint it receives, so returning the
 * repository root instead of the raw cwd is what collapses
 * `…/zero-memory/packages/db`, a nested checkout deep inside the tree, and the
 * stage worktree all onto the single `zero-memory` project — the drift that
 * filed a subdirectory's sessions under a phantom project named after that
 * subdirectory.
 *
 * Falls back to the raw path when it is not inside any git repository (or git
 * is unavailable, or the path no longer exists) — i.e. the previous basename
 * behaviour, so non-git directories are unaffected. Resolution is cached per
 * path (the watcher sees the same cwd across many chunks).
 */
const cache = new Map<string, string>();

export const resolveProjectHint = (rawCwd: string): string => {
  const cwd = rawCwd.trim();
  if (cwd === '') return rawCwd;
  const cached = cache.get(cwd);
  if (cached !== undefined) return cached;
  const resolved = outermostRepoRoot(cwd) ?? rawCwd;
  cache.set(cwd, resolved);
  return resolved;
};

/** Clears the resolution cache — for tests. */
export const clearProjectHintCache = (): void => cache.clear();

const runGit = (cwd: string, args: readonly string[]): string | null => {
  try {
    const result = spawnSync('git', ['-C', cwd, ...args], {
      encoding: 'utf8',
      timeout: 2000,
    });
    if (result.status !== 0) return null;
    const out = result.stdout.trim();
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
};

/**
 * The repository root for one level, collapsing a LINKED WORKTREE onto its main
 * working tree: a worktree's common dir is the main repo's `.git`, so its parent
 * is the real project root.
 */
const repoRoot = (cwd: string): string | null => {
  const top = runGit(cwd, ['rev-parse', '--show-toplevel']);
  if (top === null) return null;
  const common = runGit(cwd, [
    'rev-parse',
    '--path-format=absolute',
    '--git-common-dir',
  ]);
  if (common !== null && /\/\.git\/?$/.test(common)) {
    const main = dirname(common.replace(/\/+$/, ''));
    if (main.length > 0) return main;
  }
  return top;
};

/**
 * Walks outward through enclosing repositories so a NESTED repo (e.g. a private
 * notes checkout kept inside the working tree) collapses onto its host repo.
 */
const outermostRepoRoot = (cwd: string): string | null => {
  let root = repoRoot(cwd);
  if (root === null) return null;
  for (let i = 0; i < 12; i += 1) {
    const parent = dirname(root);
    if (parent === root) break;
    const enclosing = repoRoot(parent);
    if (enclosing === null || enclosing === root) break;
    root = enclosing;
  }
  return root;
};
