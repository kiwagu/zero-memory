import { spawnSync } from 'node:child_process';

import { runGit } from '../git.js';

const SHA = /^[0-9a-f]{7,64}$/u;

/** The commit a tag points at (an annotated tag is peeled), or null. */
export const tagCommit = (cwd: string, tag: string): string | null =>
  runGit(cwd, [
    'rev-parse',
    '--verify',
    '--quiet',
    `refs/tags/${tag}^{commit}`,
  ]);

/** The newest tag matching a release pattern, by version order, or null. */
export const latestTag = (cwd: string, pattern: string): string | null => {
  // A pattern is data from the project's setting: never let it read as an option.
  if (pattern.startsWith('-')) return null;
  const out = runGit(cwd, ['tag', '--list', '--sort=-v:refname', pattern]);
  return out?.split('\n')[0]?.trim() || null;
};

/**
 * Whether a landing is part of a release commit's history. `merge-base
 * --is-ancestor` answers by exit status alone, which `runGit` cannot carry,
 * so it is spawned here; a landing this checkout does not hold is not carried.
 */
export const isAncestorOf = (
  cwd: string,
  sha: string,
  commit: string
): boolean => {
  if (!SHA.test(sha)) return false;
  const full = runGit(cwd, [
    'rev-parse',
    '--verify',
    '--quiet',
    `${sha}^{commit}`,
  ]);
  if (full === null) return false;
  try {
    return (
      spawnSync(
        'git',
        ['-C', cwd, 'merge-base', '--is-ancestor', full, commit],
        {
          timeout: 2000,
        }
      ).status === 0
    );
  } catch {
    return false;
  }
};
