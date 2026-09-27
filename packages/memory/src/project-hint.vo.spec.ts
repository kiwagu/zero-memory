import { describe, expect, it } from 'vitest';

import { isProjectNameHint, normalizeProjectHint } from './project-hint.vo.js';

describe('normalizeProjectHint', () => {
  it('normalizes https git remotes', () => {
    const hint = normalizeProjectHint(
      'https://GitHub.com/Acme/Zero-Memory.git'
    ).unwrap();
    expect(hint).toEqual({
      kind: 'git_remote',
      key: 'github.com/acme/zero-memory',
      slug: 'zero_memory',
    });
  });

  it('normalizes scp-style ssh remotes to the same key', () => {
    const hint = normalizeProjectHint(
      'git@github.com:acme/zero-memory.git'
    ).unwrap();
    expect(hint.kind).toBe('git_remote');
    expect(hint.key).toBe('github.com/acme/zero-memory');
    expect(hint.slug).toBe('zero_memory');
  });

  it('normalizes ssh:// remotes', () => {
    const hint = normalizeProjectHint(
      'ssh://git@github.com/acme/zero-memory.git'
    ).unwrap();
    expect(hint.key).toBe('github.com/acme/zero-memory');
  });

  it('normalizes filesystem paths and slugifies the last segment', () => {
    const hint = normalizeProjectHint('/home/dev/repos/My-App//').unwrap();
    expect(hint).toEqual({
      kind: 'path',
      key: '/home/dev/repos/My-App',
      slug: 'my_app',
    });
  });

  it('rejects empty and unusable hints', () => {
    expect(normalizeProjectHint('   ').isErr()).toBe(true);
    expect(normalizeProjectHint('/').isErr()).toBe(true);
    expect(normalizeProjectHint('https://github.com/').isErr()).toBe(true);
  });
});

describe('isProjectNameHint', () => {
  it('treats a bare name in any spelling as a name', () => {
    for (const hint of ['zero-memory', 'Zero Memory', 'zero_memory', 'ZM']) {
      expect(isProjectNameHint(hint)).toBe(true);
    }
  });

  it('treats a scope path as a name, since it carries no slash', () => {
    expect(isProjectNameHint('proj.usr_abc.zero_memory')).toBe(true);
  });

  it('treats paths and git remotes as machine identities', () => {
    for (const hint of [
      '/home/dev/repos/zero-memory',
      'repos/zero-memory',
      '~/repos/zero-memory',
      'C:\\repos\\zero-memory',
      'https://github.com/acme/zero-memory.git',
      'git@github.com:acme/zero-memory.git',
      'ssh://git@github.com/acme/zero-memory.git',
    ]) {
      expect(isProjectNameHint(hint)).toBe(false);
    }
  });

  it('does not call an empty hint a name', () => {
    expect(isProjectNameHint('   ')).toBe(false);
  });
});
