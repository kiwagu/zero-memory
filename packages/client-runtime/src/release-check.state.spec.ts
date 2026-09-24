import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  readReleaseState,
  RELEASE_RETRY_MS,
  releaseCheckStatePath,
  releaseHandledDue,
  writeReleaseState,
} from './release-check.state.js';

const T = Date.parse('2026-09-24T08:00:00Z');

describe('the release check state', () => {
  let dir: string;
  let path: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'zm-release-state-'));
    path = join(dir, 'zero-memory', 'release-checks.json');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('lives beside the other checks', () => {
    expect(releaseCheckStatePath({ XDG_STATE_HOME: '/x' })).toBe(
      '/x/zero-memory/release-checks.json'
    );
  });

  it('keeps each project apart', () => {
    writeReleaseState(path, 'proj.a', {
      seen: { version: '1.0.0', build: null },
      current: '1.0.0',
      settings_attempt_at: T,
    });
    writeReleaseState(path, 'proj.b', {
      seen: { version: '2.0.0', build: 'x' },
    });
    writeReleaseState(path, 'proj.c', { last_fetch_at: T, url_failed_at: T });
    expect(readReleaseState(path, 'proj.c').url_failed_at).toBe(T);
    expect(readReleaseState(path, 'proj.a').url_failed_at).toBeUndefined();
    expect(readReleaseState(path, 'proj.a').seen?.version).toBe('1.0.0');
    expect(readReleaseState(path, 'proj.a').current).toBe('1.0.0');
    expect(readReleaseState(path, 'proj.a').settings_attempt_at).toBe(T);
    expect(
      readReleaseState(path, 'proj.b').settings_attempt_at
    ).toBeUndefined();
    expect(readReleaseState(path, 'proj.b').seen?.build).toBe('x');
    expect(readReleaseState(path, 'proj.d')).toEqual({});
  });

  it('asks again only for a new version, or after the pause for one that did not finish', () => {
    const state = {
      handled: {
        '1.0.0': { outcome: 'recorded' as const, at: T },
        '0.9.0': { outcome: 'rollback' as const, at: T },
        '1.1.0': { outcome: 'error' as const, at: T },
        '1.2.0': { outcome: 'no-tag' as const, at: T },
      },
    };
    expect(releaseHandledDue(state, '2.0.0', T)).toBe(true);
    expect(releaseHandledDue(state, '1.0.0', T + 60 * RELEASE_RETRY_MS)).toBe(
      false
    );
    expect(releaseHandledDue(state, '0.9.0', T + 60 * RELEASE_RETRY_MS)).toBe(
      false
    );
    expect(releaseHandledDue(state, '1.1.0', T + RELEASE_RETRY_MS - 1)).toBe(
      false
    );
    expect(releaseHandledDue(state, '1.1.0', T + RELEASE_RETRY_MS)).toBe(true);
    expect(releaseHandledDue(state, '1.2.0', T + RELEASE_RETRY_MS)).toBe(true);
  });

  it('keeps the fifty newest versions of a project', () => {
    const handled = Object.fromEntries(
      Array.from({ length: 60 }, (_, i) => [
        `1.0.${i}`,
        { outcome: 'recorded' as const, at: T + i },
      ])
    );
    writeReleaseState(path, 'proj.a', { handled });
    const kept = Object.keys(readReleaseState(path, 'proj.a').handled ?? {});
    expect(kept).toHaveLength(50);
    expect(kept).toContain('1.0.59');
    expect(kept).not.toContain('1.0.0');
  });

  it('reads a damaged file as empty and never throws on a write it cannot make', () => {
    mkdirSync(join(dir, 'zero-memory'), { recursive: true });
    writeFileSync(path, '{not json');
    expect(readReleaseState(path, 'proj.a')).toEqual({});
    expect(() =>
      writeReleaseState(join(path, 'under-a-file.json'), 'proj.a', {})
    ).not.toThrow();
  });
});
