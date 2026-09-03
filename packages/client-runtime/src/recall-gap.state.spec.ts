import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  countMemoryTool,
  loadRecallGapState,
  markRecallGapReminded,
  MAX_TRACKED_SESSIONS,
  readRecallGapCounters,
  recallGapStatePath,
} from './recall-gap.state.js';

const statePath = (): string =>
  join(mkdtempSync(join(tmpdir(), 'zm-recall-gap-')), 'recall-gap.json');

describe('readRecallGapCounters', () => {
  it('reads an unknown session as a fresh one', () => {
    // A first firing and a lost state file must behave identically, and the safe
    // direction is to leave the reminder possible rather than suppress it.
    expect(readRecallGapCounters(statePath(), 'nope')).toEqual({
      recalls: 0,
      remembers: 0,
      remindedOnFailure: false,
      remindedOnTurnEnd: false,
      remindedOnSearch: false,
    });
  });

  it('survives a corrupt state file instead of throwing', () => {
    const path = statePath();
    writeFileSync(path, 'not json at all');
    expect(readRecallGapCounters(path, 's1').recalls).toBe(0);
  });
});

describe('countMemoryTool', () => {
  it('accumulates reads and writes per session', () => {
    const path = statePath();
    countMemoryTool(path, 's1', 'recall', 1);
    countMemoryTool(path, 's1', 'recall', 2);
    countMemoryTool(path, 's1', 'remember', 3);
    expect(readRecallGapCounters(path, 's1')).toMatchObject({
      recalls: 2,
      remembers: 1,
    });
  });

  it('keeps sessions independent', () => {
    const path = statePath();
    countMemoryTool(path, 's1', 'recall', 1);
    countMemoryTool(path, 's2', 'remember', 2);
    expect(readRecallGapCounters(path, 's2')).toMatchObject({
      recalls: 0,
      remembers: 1,
    });
  });
});

describe('markRecallGapReminded', () => {
  it('records each trigger separately', () => {
    const path = statePath();
    markRecallGapReminded(path, 's1', 'failure', 1);
    expect(readRecallGapCounters(path, 's1')).toMatchObject({
      remindedOnFailure: true,
      remindedOnTurnEnd: false,
      remindedOnSearch: false,
    });
    markRecallGapReminded(path, 's1', 'turn-end', 2);
    expect(readRecallGapCounters(path, 's1')).toMatchObject({
      remindedOnFailure: true,
      remindedOnTurnEnd: true,
    });
  });

  it('does not lose counters already recorded for the session', () => {
    const path = statePath();
    countMemoryTool(path, 's1', 'remember', 1);
    markRecallGapReminded(path, 's1', 'turn-end', 2);
    expect(readRecallGapCounters(path, 's1')).toMatchObject({
      remembers: 1,
      remindedOnTurnEnd: true,
    });
  });
});

describe('state file growth', () => {
  it('prunes to the most recently touched sessions', () => {
    const path = statePath();
    for (let i = 0; i < MAX_TRACKED_SESSIONS + 25; i += 1) {
      countMemoryTool(path, `s${i}`, 'recall', i + 1);
    }
    const kept = Object.keys(loadRecallGapState(path));
    expect(kept).toHaveLength(MAX_TRACKED_SESSIONS);
    // Newest survive; the oldest are the ones dropped.
    expect(kept).toContain(`s${MAX_TRACKED_SESSIONS + 24}`);
    expect(kept).not.toContain('s0');
  });
});

describe('recallGapStatePath', () => {
  it('honors the XDG state home', () => {
    expect(recallGapStatePath({ XDG_STATE_HOME: '/xdg' })).toBe(
      '/xdg/zero-memory/recall-gap.json'
    );
  });
});
