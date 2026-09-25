import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { isAncestorOf, latestTag, tagCommit } from './git-release.js';

const env = {
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@t',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@t',
};
const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  }).trim();
const commit = (cwd: string, file: string): string => {
  writeFileSync(join(cwd, file), file);
  git(cwd, 'add', file);
  git(cwd, 'commit', '-q', '-m', `add ${file}`);
  return git(cwd, 'rev-parse', 'HEAD');
};

describe('release facts from git', () => {
  let repo: string;
  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'zm-git-release-'));
    git(repo, 'init', '-q', '-b', 'main');
  });
  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  it('resolves a tag to its commit, and a missing tag to nothing', () => {
    const a = commit(repo, 'a');
    git(repo, 'tag', '-a', 'v1.0.0', '-m', 'annotated', a);
    expect(tagCommit(repo, 'v1.0.0')).toBe(a);
    expect(tagCommit(repo, 'v9.9.9')).toBeNull();
  });

  it('picks the newest release tag by version, not by text', () => {
    const a = commit(repo, 'a');
    git(repo, 'tag', 'v0.9.0', a);
    git(repo, 'tag', 'v0.10.0', a);
    git(repo, 'tag', 'nightly', a);
    expect(latestTag(repo, 'v*', 'v{version}')).toEqual({
      tag: 'v0.10.0',
      version: '0.10.0',
    });
    expect(latestTag(repo, 'release-*', 'v{version}')).toBeNull();
    expect(latestTag(repo, '--contains', 'v{version}')).toBeNull();
  });

  it('puts a final release above its pre-releases, and skips a tag that is no version', () => {
    const a = commit(repo, 'a');
    git(repo, 'tag', 'v1.2.0-rc.1', a);
    git(repo, 'tag', 'v1.2.0', a);
    git(repo, 'tag', 'v1.1.9', a);
    git(repo, 'tag', 'vnext', a);
    expect(latestTag(repo, 'v*', 'v{version}')).toEqual({
      tag: 'v1.2.0',
      version: '1.2.0',
    });
    git(repo, 'tag', 'v1.3.0-rc.1', a);
    expect(latestTag(repo, 'v*', 'v{version}')).toEqual({
      tag: 'v1.3.0-rc.1',
      version: '1.3.0-rc.1',
    });
  });

  it('runs no git once its time is spent', () => {
    const a = commit(repo, 'a');
    git(repo, 'tag', 'v1.0.0', a);
    expect(tagCommit(repo, 'v1.0.0', 0)).toBeNull();
    expect(latestTag(repo, 'v*', 'v{version}', 0)).toBeNull();
    expect(isAncestorOf(repo, a, a, 0)).toBe(false);
    expect(tagCommit(repo, 'v1.0.0', 2000)).toBe(a);
    expect(isAncestorOf(repo, a, a, 2000)).toBe(true);
  });

  it('tells a landing the release carries from one it does not', () => {
    const landed = commit(repo, 'a');
    const release = commit(repo, 'b');
    const after = commit(repo, 'c');
    expect(isAncestorOf(repo, landed, release)).toBe(true);
    expect(isAncestorOf(repo, landed.slice(0, 7), release)).toBe(true);
    expect(isAncestorOf(repo, release, release)).toBe(true);
    expect(isAncestorOf(repo, after, release)).toBe(false);
    expect(isAncestorOf(repo, 'deadbee', release)).toBe(false);
    expect(isAncestorOf(repo, '--help', release)).toBe(false);
  });
});
