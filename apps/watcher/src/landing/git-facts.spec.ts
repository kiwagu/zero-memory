import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { findLanding, readGitFacts, recentSquashes } from './git-facts.js';

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@t',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@t',
    },
  }).trim();

const commit = (cwd: string, file: string, ...messages: string[]): string => {
  writeFileSync(join(cwd, file), `${file}\n`);
  git(cwd, 'add', file);
  git(cwd, 'commit', '-q', ...messages.flatMap((m) => ['-m', m]));
  return git(cwd, 'rev-parse', 'HEAD');
};

describe('git facts', () => {
  let repo: string;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'zm-git-facts-'));
    git(repo, 'init', '-q', '-b', 'main');
    commit(repo, 'a.txt', 'chore: start');
  });
  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  it('names the repository by its origin, or by its folder without one', () => {
    expect(readGitFacts(repo)).toEqual({
      root: repo,
      identity: basename(repo),
      head: 'main',
    });
    git(
      repo,
      'remote',
      'add',
      'origin',
      'git@github.com:acme/memory-service.git'
    );
    expect(readGitFacts(repo)?.identity).toBe('acme/memory-service');
  });

  it('knows no branch on a detached head, and nothing outside a repository', () => {
    git(repo, 'checkout', '-q', '--detach');
    expect(readGitFacts(repo)?.head).toBeNull();
    expect(readGitFacts(tmpdir())).toBeNull();
  });

  it('finds a squash even under the release commit made right after it', () => {
    const squash = commit(
      repo,
      'b.txt',
      'feat: the work',
      'Squashed-from: feature/x (abcdef1) ZM-19 ZM-20'
    );
    commit(repo, 'c.txt', 'chore(release): 0.30.0');
    expect(recentSquashes(repo, 8, 12)).toEqual([
      {
        sha: squash,
        trailers: [{ branch: 'feature/x', tipSha: 'abcdef1', cards: [19, 20] }],
      },
    ]);
  });

  it('finds the squash of exactly the branch asked for', () => {
    git(repo, 'checkout', '-q', '-b', 'release/1x2');
    git(repo, 'checkout', '-q', 'main');
    const decoy = commit(
      repo,
      'd.txt',
      'feat: decoy',
      'Squashed-from: release/1x2 (1111111) ZM-1'
    );
    const real = commit(
      repo,
      'e.txt',
      'feat: real',
      'Squashed-from: release/1.2 (2222222) ZM-2'
    );
    expect(findLanding(repo, 'release/1.2')).toEqual({
      sha: real,
      target: 'main',
    });
    expect(findLanding(repo, 'release/1x2')).toEqual({
      sha: decoy,
      target: 'main',
    });
    expect(findLanding(repo, 'feature/none')).toBeNull();
  });

  it('does not take a commit that only quotes a trailer for a landing', () => {
    commit(
      repo,
      'f.txt',
      'docs: how to squash',
      'Write `Squashed-from: feature/q (1234567) ZM-3` as the trailer'
    );
    expect(findLanding(repo, 'feature/q')).toBeNull();
  });
});
