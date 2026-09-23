import { basename, dirname } from 'node:path';

import {
  escapeGitRegex,
  parseSquashTrailers,
  repoIdentityFromRemote,
  type SquashTrailer,
} from '@workspace/client-core';

import { runGit } from '../git.js';

/**
 * What the landing check needs to know about the repository a command ran
 * in: its root, its name as the board names it, and the branch checked out.
 */
export interface GitFacts {
  root: string;
  identity: string;
  /** The branch checked out, or null on a detached head. */
  head: string | null;
}

export const readGitFacts = (cwd: string): GitFacts | null => {
  const root = runGit(cwd, ['rev-parse', '--show-toplevel']);
  if (root === null) return null;
  // A linked worktree is named after its main checkout, not its own folder.
  const common = runGit(root, [
    'rev-parse',
    '--path-format=absolute',
    '--git-common-dir',
  ]);
  const mainRoot =
    common !== null && /\/\.git\/?$/u.test(common)
      ? dirname(common.replace(/\/+$/u, ''))
      : root;
  const remote = runGit(root, ['remote', 'get-url', 'origin']);
  const identity =
    (remote !== null ? repoIdentityFromRemote(remote) : null) ??
    basename(mainRoot);
  const head = runGit(root, ['rev-parse', '--abbrev-ref', 'HEAD']);
  return {
    root,
    identity,
    head: head !== null && head !== 'HEAD' ? head : null,
  };
};

export interface RecentSquash {
  sha: string;
  trailers: SquashTrailer[];
}

/**
 * The squash commits among the last few on the checked-out branch, made in
 * the last few hours. More than HEAD alone: a release commit made by the same
 * command sits on top of the squash it follows.
 */
export const recentSquashes = (
  root: string,
  count: number,
  sinceHours: number
): RecentSquash[] => {
  const log = runGit(root, [
    'log',
    `-n${count}`,
    `--since=${sinceHours}.hours.ago`,
    '--format=%H%x1f%B%x1e',
    'HEAD',
  ]);
  if (log === null) return [];
  return log
    .split('\x1e')
    .map((record) => record.trim())
    .filter(Boolean)
    .map((record) => {
      const [sha = '', body = ''] = record.split('\x1f');
      return { sha: sha.trim(), trailers: parseSquashTrailers(body) };
    })
    .filter((squash) => squash.sha !== '' && squash.trailers.length > 0);
};

/**
 * Where a branch landed, if a local branch carries its squash: the newest
 * commit whose trailer names exactly this branch, and the branch that holds
 * it — the checked-out one, else `main`, else the first other.
 */
export const findLanding = (
  root: string,
  branch: string
): { sha: string; target: string } | null => {
  const sha = runGit(root, [
    'log',
    '--branches',
    '-E',
    `--grep=^Squashed-from: ${escapeGitRegex(branch)} \\(`,
    '-n1',
    '--format=%H',
  ]);
  if (sha === null) return null;
  const holders = (
    runGit(root, ['branch', '--contains', sha, '--format=%(refname:short)']) ??
    ''
  )
    .split('\n')
    .map((name) => name.trim())
    .filter((name) => name !== '' && name !== branch);
  const head = runGit(root, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const target =
    holders.find((name) => name === head) ??
    holders.find((name) => name === 'main') ??
    holders[0];
  return target ? { sha, target } : null;
};
