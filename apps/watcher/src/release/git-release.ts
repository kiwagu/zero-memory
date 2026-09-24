import { spawnSync } from 'node:child_process';

import { compareVersions, versionFromTag } from '@workspace/client-core';

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

/**
 * The highest release among the tags matching a release pattern, with the
 * version its template reads from it, or null. Ordered by the release's own
 * precedence rather than git's version sort, which puts `v1.2.0-rc.1` above
 * `v1.2.0` unless the user configured otherwise; a matching tag the template
 * reads no version from is not a release.
 */
export const latestTag = (
  cwd: string,
  pattern: string,
  template: string
): { tag: string; version: string } | null => {
  // A pattern is data from the project's setting: never let it read as an option.
  if (pattern.startsWith('-')) return null;
  const out = runGit(cwd, ['tag', '--list', '--no-column', pattern]);
  let latest: { tag: string; version: string } | null = null;
  for (const line of out?.split('\n') ?? []) {
    const tag = line.trim();
    const version = versionFromTag(template, tag);
    if (
      version !== null &&
      (latest === null || compareVersions(version, latest.version) > 0)
    ) {
      latest = { tag, version };
    }
  }
  return latest;
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
