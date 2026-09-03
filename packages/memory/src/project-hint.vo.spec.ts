import { describe, expect, it } from 'vitest';

import { normalizeProjectHint } from './project-hint.vo.js';

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
