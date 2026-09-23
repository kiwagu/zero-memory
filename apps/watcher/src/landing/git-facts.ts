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
 * The squash commits among the newest on every local branch, made in the last
 * few hours. Every branch rather than HEAD alone: a release commit made by the
 * same command sits on top of the squash it follows, and a squash made from
 * another worktree lands on a branch this one does not have checked out —
 * worktrees share their branches. Runs from any directory inside the
 * repository; outside one it finds nothing.
 */
export const recentSquashes = (
  cwd: string,
  count: number,
  sinceHours: number
): RecentSquash[] => {
  const log = runGit(cwd, [
    'log',
    '--branches',
    `-n${count}`,
    `--since=${sinceHours}.hours.ago`,
    '--format=%H%x1f%B%x1e',
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

/** Branch names that usually receive landings, in the order they are tried. */
const TRUNKS = ['main', 'master', 'dev'];

/**
 * The branch a squash commit landed on. Containing a commit does not say
 * where it landed — a branch started from the trunk after the landing
 * contains it too — so the trunk wins: the remote's default branch, then the
 * usual trunk names, and only then whatever else holds it, the checked-out
 * branch first. The landed branch itself is never its own target.
 */
export const landingTarget = (
  root: string,
  sha: string,
  landedBranch: string
): string | null => {
  const holders = (
    runGit(root, ['branch', '--contains', sha, '--format=%(refname:short)']) ??
    ''
  )
    .split('\n')
    .map((name) => name.trim())
    .filter((name) => name !== '' && name !== landedBranch);
  if (holders.length === 0) return null;
  const remoteDefault = runGit(root, [
    'symbolic-ref',
    '--quiet',
    '--short',
    'refs/remotes/origin/HEAD',
  ])?.replace(/^origin\//u, '');
  const preferred = [...(remoteDefault ? [remoteDefault] : []), ...TRUNKS];
  const trunk = preferred.find((name) => holders.includes(name));
  if (trunk) return trunk;
  const head = runGit(root, ['rev-parse', '--abbrev-ref', 'HEAD']);
  return holders.find((name) => name === head) ?? holders[0] ?? null;
};

/**
 * Where a branch landed, if a local branch carries its squash: the newest
 * commit whose trailer names exactly this branch, and the branch it landed on.
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
  const target = landingTarget(root, sha, branch);
  return target ? { sha, target } : null;
};
