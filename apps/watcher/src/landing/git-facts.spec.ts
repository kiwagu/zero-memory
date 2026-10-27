import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { commit, git, initRepo } from '../testing/git-repo.fixture.js';
import { findLanding, readGitFacts, recentSquashes } from './git-facts.js';

describe('git facts', () => {
  let repo: string;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'zm-git-facts-'));
    initRepo(repo);
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

  it('names the trunk as the target even after work moved to a new branch', () => {
    const squash = commit(
      repo,
      'n.txt',
      'feat: landed',
      'Squashed-from: feature/x (abcdef1) ZM-19'
    );
    git(repo, 'checkout', '-q', '-b', 'feature/next');
    commit(repo, 'o.txt', 'feat: the next piece of work');
    expect(findLanding(repo, 'feature/x')).toEqual({
      sha: squash,
      target: 'main',
    });
  });

  it('sees a squash on any local branch, not only the one checked out', () => {
    git(repo, 'checkout', '-q', '-b', 'feature/y');
    git(repo, 'checkout', '-q', 'main');
    const squash = commit(
      repo,
      'p.txt',
      'feat: landed on main',
      'Squashed-from: feature/y (1234567) ZM-7'
    );
    git(repo, 'checkout', '-q', 'feature/y');
    expect(recentSquashes(repo, 8, 12).map((found) => found.sha)).toEqual([
      squash,
    ]);
  });

  it('counts only squashes toward its limit, not ordinary work elsewhere', () => {
    const squash = commit(
      repo,
      'q.txt',
      'feat: landed',
      'Squashed-from: feature/z (7654321) ZM-8'
    );
    git(repo, 'checkout', '-q', '-b', 'feature/busy');
    for (let i = 0; i < 9; i += 1) {
      commit(repo, `busy-${i}.txt`, `feat: ordinary work ${i}`);
    }
    expect(recentSquashes(repo, 8, 12).map((found) => found.sha)).toEqual([
      squash,
    ]);
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
