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
import { landingCheckStatePath } from './landing-check.state.js';
import { defaultStatePath } from './offset-state.js';
import { projectScopeStatePath } from './project-scope.state.js';
import { recallGapStatePath } from './recall-gap.state.js';
import { releaseCheckStatePath } from './release-check.state.js';
import { receiptStatePath } from './session-receipt.state.js';
import {
  loadStateRecord,
  saveCappedStateRecord,
  stateFilePath,
} from './state-file.js';
import { briefStatePath } from './task-brief.state.js';

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
