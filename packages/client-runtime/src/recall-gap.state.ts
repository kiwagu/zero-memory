import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import type { RecallGapCounters } from '@workspace/client-core';

/**
 * Per-session memory-usage counters for the recall reminder, persisted in the
 * XDG state directory beside the other hook state.
 *
 * It has to be a FILE rather than process memory because each hook firing is its
 * own short-lived process — the count of what a session has read exists nowhere
 * else. Nothing here is content: only how many reads and writes a session made
 * and which reminders it has already been shown.
 */

export interface RecallGapSession {
  /** Calls to the read tools — the gate for every reminder. */
  recalls: number;
  /** Calls to the write tool. */
  remembers: number;
  reminded_on_failure?: boolean;
  reminded_on_turn_end?: boolean;
  reminded_on_search?: boolean;
  /** Last update (epoch ms) — the pruning key. */
  at: number;
}

export type RecallGapStateFile = Record<string, RecallGapSession>;

/** Oldest entries beyond this are pruned on save (state must not grow forever). */
export const MAX_TRACKED_SESSIONS = 200;

/** Default state-file location; tests pass their own path. */
export const recallGapStatePath = (
  env: NodeJS.ProcessEnv = process.env
): string =>
  join(
    env.XDG_STATE_HOME ?? join(homedir(), '.local', 'state'),
    'zero-memory',
    'recall-gap.json'
  );

export const loadRecallGapState = (path: string): RecallGapStateFile => {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as RecallGapStateFile;
  } catch {
    return {};
  }
};

const save = (path: string, state: RecallGapStateFile): void => {
  const entries = Object.entries(state)
    .sort(([, a], [, b]) => b.at - a.at)
    .slice(0, MAX_TRACKED_SESSIONS);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(Object.fromEntries(entries), null, 2));
};

const blank = (now: number): RecallGapSession => ({
  recalls: 0,
  remembers: 0,
  at: now,
});

/**
 * A session's counters, in the shape the decision consumes.
 *
 * An unknown session reads as a fresh one rather than an error: a first firing
 * and a lost state file must behave identically, and the safe direction is to
 * let the reminder be possible rather than to suppress it silently.
 */
export const readRecallGapCounters = (
  path: string,
  sessionId: string
): RecallGapCounters => {
  const session = loadRecallGapState(path)[sessionId];
  return {
    recalls: session?.recalls ?? 0,
    remembers: session?.remembers ?? 0,
    remindedOnFailure: session?.reminded_on_failure === true,
    remindedOnTurnEnd: session?.reminded_on_turn_end === true,
    remindedOnSearch: session?.reminded_on_search === true,
  };
};

/** Increments the read or write counter for a session. */
export const countMemoryTool = (
  path: string,
  sessionId: string,
  tally: 'recall' | 'remember',
  now: number = Date.now()
): void => {
  const state = loadRecallGapState(path);
  const session = state[sessionId] ?? blank(now);
  if (tally === 'recall') session.recalls += 1;
  else session.remembers += 1;
  session.at = now;
  state[sessionId] = session;
  save(path, state);
};

const FLAGS = {
  failure: 'reminded_on_failure',
  'turn-end': 'reminded_on_turn_end',
  search: 'reminded_on_search',
} as const;

/**
 * Records that a reminder has been shown, so it fires at most once per session.
 *
 * Written BEFORE the reminder is emitted by the caller: if the process were to
 * die between the two, a reminder that was never seen is a far smaller cost than
 * one that repeats on every firing.
 */
export const markRecallGapReminded = (
  path: string,
  sessionId: string,
  trigger: keyof typeof FLAGS,
  now: number = Date.now()
): void => {
  const state = loadRecallGapState(path);
  const session = state[sessionId] ?? blank(now);
  session[FLAGS[trigger]] = true;
  session.at = now;
  state[sessionId] = session;
  save(path, state);
};
