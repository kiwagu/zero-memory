import { describe, expect, it } from 'vitest';

import {
  clearProjectHintCache,
  resolveProjectHint,
} from './project-hint-resolver.js';

describe('resolveProjectHint', () => {
  it('passes an empty hint through', () => {
    expect(resolveProjectHint('')).toBe('');
  });

  it('returns a non-git path unchanged (previous basename behaviour)', () => {
    clearProjectHintCache();
    const notARepo = '/definitely/not/a/git/repo/xyz123';
    expect(resolveProjectHint(notARepo)).toBe(notARepo);
  });

  it('collapses a subdirectory of a repo to the enclosing repo root', () => {
    clearProjectHintCache();
    // This test file lives several directories deep inside the repo; resolving
    // its own directory must yield an ANCESTOR (the repo root), never the leaf.
    const dir = import.meta.dirname;
    const resolved = resolveProjectHint(dir);
    expect(dir.startsWith(resolved)).toBe(true);
    expect(resolved.length).toBeLessThan(dir.length);
  });

  it('is stable and cached across calls', () => {
    clearProjectHintCache();
    const dir = import.meta.dirname;
    expect(resolveProjectHint(dir)).toBe(resolveProjectHint(dir));
  });
});
