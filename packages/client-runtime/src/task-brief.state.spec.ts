import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  briefStatePath,
  loadBriefState,
  markRulesDelivered,
  markTaskBriefed,
  MAX_TRACKED_SESSIONS,
  readSessionThread,
  recordSessionBriefing,
  recordSessionThread,
  stampSessionStart,
} from './task-brief.state.js';

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'zm-brief-state-'));
  path = join(dir, 'session-briefs.json');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('brief state file', () => {
  it('resolves the default path under XDG_STATE_HOME', () => {
    expect(briefStatePath({ XDG_STATE_HOME: '/tmp/state' })).toBe(
      '/tmp/state/zero-memory/session-briefs.json'
    );
  });

  it('loads an empty state when the file is missing or corrupt', () => {
    expect(loadBriefState(path)).toEqual({});
  });

  it('records injected ids and merges them across re-briefings', () => {
    recordSessionBriefing(path, 'sess-1', ['mem_a', 'mem_b'], 1);
    recordSessionBriefing(path, 'sess-1', ['mem_b', 'mem_c'], 2);

    expect(loadBriefState(path)['sess-1']).toEqual({
      injected_ids: ['mem_a', 'mem_b', 'mem_c'],
      task_briefed: false,
      epoch: 0,
      at: 2,
    });
  });

  it('keeps task_briefed once set, even when the session re-briefs on resume', () => {
    recordSessionBriefing(path, 'sess-1', ['mem_a'], 1);
    markTaskBriefed(path, 'sess-1', 2);
    recordSessionBriefing(path, 'sess-1', ['mem_b'], 3);

    const entry = loadBriefState(path)['sess-1'];
    expect(entry?.task_briefed).toBe(true);
    expect(entry?.injected_ids).toEqual(['mem_a', 'mem_b']);
  });

  it('marks a session task-briefed even without a prior session entry', () => {
    markTaskBriefed(path, 'sess-solo', 5);

    expect(loadBriefState(path)['sess-solo']).toEqual({
      injected_ids: [],
      task_briefed: true,
      epoch: 0,
      at: 5,
    });
  });

  it('keeps the FIRST session-start stamp across resumes and updates', () => {
    stampSessionStart(path, 'sess-1', 100);
    recordSessionBriefing(path, 'sess-1', ['mem_a'], 200);
    markTaskBriefed(path, 'sess-1', 300);
    stampSessionStart(path, 'sess-1', 400); // resume re-fires the hook

    const entry = loadBriefState(path)['sess-1'];
    expect(entry?.started_at).toBe(100);
    expect(entry?.task_briefed).toBe(true);
    expect(entry?.injected_ids).toEqual(['mem_a']);
  });

  it('keeps one epoch across startup and resume, so one-shots stay spent', () => {
    stampSessionStart(path, 'sess-1', 100, 'startup');
    markRulesDelivered(path, 'sess-1', 110);
    markTaskBriefed(path, 'sess-1', 120);
    stampSessionStart(path, 'sess-1', 200, 'resume');

    const entry = loadBriefState(path)['sess-1'];
    // A resume replays the transcript, so what was injected is still in view.
    expect(entry?.epoch).toBe(0);
    expect(entry?.rules_epoch).toBe(0);
    expect(entry?.task_briefed).toBe(true);
  });

  it('opens a new epoch on compaction and re-arms both per-window deliveries', () => {
    stampSessionStart(path, 'sess-1', 100, 'startup');
    markRulesDelivered(path, 'sess-1', 110);
    markTaskBriefed(path, 'sess-1', 120);

    stampSessionStart(path, 'sess-1', 300, 'compact');

    const entry = loadBriefState(path)['sess-1'];
    // The window the session was briefed into is gone: the rules record is
    // dropped and the task briefing is owed again — after a compaction the
    // task context is as absent as the rules are.
    expect(entry?.epoch).toBe(1);
    expect(entry?.rules_epoch).toBeUndefined();
    expect(entry?.task_briefed).toBe(false);
    // The session's identity survives: its start stamp and injected ids are
    // the receipt's window, not the context window.
    expect(entry?.started_at).toBe(100);
  });

  it('a cleared conversation is a boundary too', () => {
    stampSessionStart(path, 'sess-1', 100, 'startup');
    markRulesDelivered(path, 'sess-1', 110);

    stampSessionStart(path, 'sess-1', 200, 'clear');

    expect(loadBriefState(path)['sess-1']?.epoch).toBe(1);
    expect(loadBriefState(path)['sess-1']?.rules_epoch).toBeUndefined();
  });

  it('an absent reason never re-arms — a silent client must not reset epochs', () => {
    stampSessionStart(path, 'sess-1', 100);
    markRulesDelivered(path, 'sess-1', 110);
    stampSessionStart(path, 'sess-1', 200);

    const entry = loadBriefState(path)['sess-1'];
    expect(entry?.epoch).toBe(0);
    expect(entry?.rules_epoch).toBe(0);
  });

  it('records the rules as delivered into the CURRENT epoch', () => {
    stampSessionStart(path, 'sess-1', 100, 'startup');
    stampSessionStart(path, 'sess-1', 200, 'compact');
    markRulesDelivered(path, 'sess-1', 210);

    expect(loadBriefState(path)['sess-1']?.rules_epoch).toBe(1);
  });

  it('keeps each conversation’s thread token to itself', () => {
    recordSessionThread(path, 'sess-1', 'thr_one.01a', 100);
    recordSessionThread(path, 'sess-2', 'thr_two.01b', 110);

    // The bug this replaced kept ONE token per project, so the second session
    // overwrote the first and both then quoted 'thr_two'.
    expect(readSessionThread(path, 'sess-1')).toBe('thr_one.01a');
    expect(readSessionThread(path, 'sess-2')).toBe('thr_two.01b');
  });

  it('reports no token for a session that never resolved one', () => {
    recordSessionBriefing(path, 'sess-1', ['mem_a'], 100);

    expect(readSessionThread(path, 'sess-1')).toBeNull();
    expect(readSessionThread(path, 'unknown-session')).toBeNull();
  });

  it('carries the token through every other writer, boundaries included', () => {
    recordSessionThread(path, 'sess-1', 'thr_one.01a', 100);

    recordSessionBriefing(path, 'sess-1', ['mem_a'], 110);
    markTaskBriefed(path, 'sess-1', 120);
    markRulesDelivered(path, 'sess-1', 130);
    // Compaction opens a new window but keeps the client's conversation id —
    // so the token must survive the epoch bump that re-arms everything else.
    stampSessionStart(path, 'sess-1', 140, 'compact');

    const entry = loadBriefState(path)['sess-1'];
    expect(readSessionThread(path, 'sess-1')).toBe('thr_one.01a');
    expect(entry?.epoch).toBe(1);
    expect(entry?.task_briefed).toBe(false);
    expect(entry?.rules_epoch).toBeUndefined();
  });

  it('replaces the token when the conversation is re-identified', () => {
    recordSessionThread(path, 'sess-1', 'thr_one.01a', 100);
    recordSessionThread(path, 'sess-1', 'thr_one_new.01c', 110);

    expect(readSessionThread(path, 'sess-1')).toBe('thr_one_new.01c');
  });

  it('prunes the oldest sessions beyond the cap', () => {
    for (let i = 0; i < MAX_TRACKED_SESSIONS + 10; i += 1) {
      recordSessionBriefing(path, `sess-${i}`, [], i);
    }

    const state = loadBriefState(path);
    expect(Object.keys(state)).toHaveLength(MAX_TRACKED_SESSIONS);
    expect(state['sess-0']).toBeUndefined();
    expect(state[`sess-${MAX_TRACKED_SESSIONS + 9}`]).toBeDefined();
    // The file on disk is pruned too, not just the in-memory view.
    expect(
      Object.keys(JSON.parse(readFileSync(path, 'utf8'))) as string[]
    ).toHaveLength(MAX_TRACKED_SESSIONS);
  });
});
