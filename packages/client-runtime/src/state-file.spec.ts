import { homedir } from 'node:os';
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { briefCacheDir } from './brief-cache.js';
import {
  landingCheckedAt,
  landingCheckStatePath,
  recordLandingCheck,
} from './landing-check.state.js';
import { defaultStatePath } from './offset-state.js';
import {
  projectScopeStatePath,
  readProjectScope,
  recordProjectScope,
} from './project-scope.state.js';
import {
  countMemoryTool,
  readRecallGapCounters,
  recallGapStatePath,
} from './recall-gap.state.js';
import {
  readReleaseState,
  releaseCheckStatePath,
  writeReleaseState,
} from './release-check.state.js';
import {
  loadReceiptState,
  receiptStatePath,
  recordCapturedMemories,
} from './session-receipt.state.js';
import {
  loadStateRecord,
  saveCappedStateRecord,
  stateFilePath,
} from './state-file.js';
import {
  briefStatePath,
  loadBriefState,
  recordSessionBriefing,
} from './task-brief.state.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'zm-state-file-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('where state lives', () => {
  it('sits under the XDG state home, or ~/.local/state without one', () => {
    expect(stateFilePath('x.json', { XDG_STATE_HOME: '/xdg' })).toBe(
      '/xdg/zero-memory/x.json'
    );
    expect(stateFilePath('x.json', {})).toBe(
      join(homedir(), '.local', 'state', 'zero-memory', 'x.json')
    );
  });

  // The names are the on-disk contract: renaming one silently drops what
  // every machine already recorded there.
  it.each([
    [briefStatePath, 'session-briefs.json'],
    [recallGapStatePath, 'recall-gap.json'],
    [receiptStatePath, 'session-receipts.json'],
    [landingCheckStatePath, 'landing-checks.json'],
    [projectScopeStatePath, 'project-scopes.json'],
    [releaseCheckStatePath, 'release-checks.json'],
    [briefCacheDir, 'brief-cache'],
    [defaultStatePath, 'watcher.json'],
  ])('keeps %o in %s', (pathOf, name) => {
    expect(pathOf({ XDG_STATE_HOME: '/xdg' })).toBe(`/xdg/zero-memory/${name}`);
  });
});

describe('loadStateRecord', () => {
  it('reads what was written', () => {
    const path = join(dir, 'state.json');
    writeFileSync(path, JSON.stringify({ a: { at: 1 } }));
    expect(loadStateRecord(path)).toEqual({ a: { at: 1 } });
  });

  it.each([
    ['no file at all', null],
    ['text that is not JSON', 'not json'],
    ['a write cut off mid-way', '{"sess-1": {"tail": {"memo'],
    ['the JSON literal null', 'null'],
    ['an array', '[]'],
    ['a bare string', '"session-briefs"'],
  ])('reads %s as nothing recorded yet', (_, raw) => {
    const path = join(dir, 'state.json');
    if (raw !== null) writeFileSync(path, raw);
    expect(loadStateRecord(path)).toEqual({});
  });
});

describe('saveCappedStateRecord', () => {
  it('keeps the newest entries past its cap, on disk, creating the directory', () => {
    const path = join(dir, 'nested', 'state.json');
    const state = Object.fromEntries(
      Array.from({ length: 5 }, (_, i) => [
        `s${i}`,
        { at: [3, 0, 4, 1, 2][i]! },
      ])
    );

    saveCappedStateRecord(path, state, 3, (entry) => entry.at);

    expect(statSync(path).isFile()).toBe(true);
    // Newest first, indented: the file stays readable by hand.
    expect(readFileSync(path, 'utf8')).toBe(
      JSON.stringify({ s2: { at: 4 }, s0: { at: 3 }, s4: { at: 2 } }, null, 2)
    );
  });
});

/**
 * Each state module, through its own public reader and writer: the shared
 * owner above only protects a module that actually goes through it. A module
 * whose loader drifts back to a bare `JSON.parse` throws on a damaged file in
 * every hook again; one whose save loses its cap grows forever.
 */
describe('every state module goes through the shared owner', () => {
  interface StateModule {
    readonly file: string;
    /** Whether `key` is recorded, read through the module's public reader. */
    readonly read: (path: string, key: string) => boolean;
    /** Records `key` at time `at` through the module's public writer. */
    readonly write: (path: string, key: string, at: number) => void;
    /** Entries kept past which the oldest go; null for a file not capped so. */
    readonly cap: number | null;
  }

  const MODULES: StateModule[] = [
    {
      file: 'session-briefs.json',
      read: (path, key) => key in loadBriefState(path),
      write: (path, key, at) => recordSessionBriefing(path, key, [], at),
      cap: 200,
    },
    {
      file: 'recall-gap.json',
      read: (path, key) => readRecallGapCounters(path, key).recalls > 0,
      write: (path, key, at) => countMemoryTool(path, key, 'recall', at),
      cap: 200,
    },
    {
      file: 'session-receipts.json',
      read: (path, key) => loadReceiptState(path)[key] !== undefined,
      write: (path, key, at) => recordCapturedMemories(path, key, 1, at),
      cap: 200,
    },
    {
      file: 'landing-checks.json',
      read: (path, key) => landingCheckedAt(path, key) !== undefined,
      write: (path, key, at) => recordLandingCheck(path, key, 'recorded', at),
      cap: 500,
    },
    {
      file: 'project-scopes.json',
      read: (path, key) => readProjectScope(path, key) !== null,
      write: (path, key, at) => recordProjectScope(path, key, 'proj.x', at),
      cap: 200,
    },
    {
      // Kept per project, and capped inside a project by its own spec.
      file: 'release-checks.json',
      read: (path, key) =>
        readReleaseState(path, key).last_fetch_at !== undefined,
      write: (path, key, at) =>
        writeReleaseState(path, key, { last_fetch_at: at }),
      cap: null,
    },
  ];

  it.each(MODULES)(
    '$file reads a damaged file as empty, writes over it, and keeps its newest entries',
    ({ read, write, cap }) => {
      const path = join(dir, 'state.json');
      writeFileSync(path, 'null');
      expect(read(path, 'k0')).toBe(false);

      const count = (cap ?? 1) + 1;
      for (let i = 0; i < count; i += 1) write(path, `k${i}`, i + 1);

      expect(read(path, `k${count - 1}`)).toBe(true);
      expect(read(path, 'k0')).toBe(cap === null);
    }
  );
});
