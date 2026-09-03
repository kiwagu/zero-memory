import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  briefCacheDir,
  briefCacheFile,
  clearBriefCache,
  readBriefCache,
  writeBriefCache,
} from './brief-cache.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const CWD = '/home/dev/repos/quokka-tool';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'zm-brief-cache-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('brief cache', () => {
  it('resolves the default dir under XDG_STATE_HOME', () => {
    expect(briefCacheDir({ XDG_STATE_HOME: '/tmp/state' })).toBe(
      '/tmp/state/zero-memory/brief-cache'
    );
  });

  it('keys files by the FULL project path, not the basename', () => {
    const a = briefCacheFile(dir, '/home/a/repos/tool');
    const b = briefCacheFile(dir, '/home/b/repos/tool');
    expect(a).not.toBe(b);
  });

  it('round-trips the last delivered briefing', () => {
    writeBriefCache(dir, CWD, 'the briefing body', 1000);

    expect(readBriefCache(dir, CWD, 1000 + DAY_MS)).toEqual({
      cwd: CWD,
      context: 'the briefing body',
      cached_at: 1000,
    });
  });

  it('misses when nothing was cached or the file is corrupt', () => {
    expect(readBriefCache(dir, CWD)).toBeNull();

    writeFileSync(briefCacheFile(dir, CWD), 'not json');
    expect(readBriefCache(dir, CWD)).toBeNull();
  });

  it('refuses a briefing older than the TTL', () => {
    writeBriefCache(dir, CWD, 'stale body', 0);

    expect(readBriefCache(dir, CWD, 7 * DAY_MS)).not.toBeNull();
    expect(readBriefCache(dir, CWD, 7 * DAY_MS + 1)).toBeNull();
  });

  it('honors a custom TTL', () => {
    writeBriefCache(dir, CWD, 'body', 0);

    expect(readBriefCache(dir, CWD, 2 * DAY_MS, 1)).toBeNull();
    expect(readBriefCache(dir, CWD, 2 * DAY_MS, 3)).not.toBeNull();
  });

  it('clears the entry for a project marked ignored', () => {
    writeBriefCache(dir, CWD, 'body', 0);
    clearBriefCache(dir, CWD);

    expect(readBriefCache(dir, CWD, 1)).toBeNull();
    // Clearing a missing entry is a no-op, not an error.
    clearBriefCache(dir, CWD);
  });

  it('overwrites: the newest delivered briefing wins', () => {
    writeBriefCache(dir, CWD, 'old body', 0);
    writeBriefCache(dir, CWD, 'new body', 10);

    expect(readBriefCache(dir, CWD, 20)?.context).toBe('new body');
    // One file per project — the overwrite did not leave a sibling.
    expect(
      readFileSync(briefCacheFile(dir, CWD), 'utf8').includes('old body')
    ).toBe(false);
  });
});
