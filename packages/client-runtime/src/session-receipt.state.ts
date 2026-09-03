import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * Per-session receipt state shared by the Stop-hook ingest (writer) and the
 * SessionEnd receipt hook (reader), persisted in the XDG state directory next
 * to the briefing state. The ingest hook accumulates how many memories each
 * of its chunks created (the receipt's "captured N" — the ingest RESPONSE is
 * the source, per the value-loop design); the receipt hook claims the session
 * once so a re-fired end event can never print a second receipt.
 */

export interface SessionReceiptState {
  /** Memories created by this session's ingested chunks (sum of responses). */
  captured: number;
  /** First capture (epoch ms) — the receipt window fallback when the
   * SessionStart stamp is missing (e.g. briefing hooks not installed). */
  first_capture_at?: number;
  /** Set once the receipt for this session has been emitted. */
  receipted: boolean;
  /** Last update (epoch ms) — the pruning key. */
  at: number;
}

export type ReceiptStateFile = Record<string, SessionReceiptState>;

/** Oldest entries beyond this are pruned on save (state must not grow forever). */
export const MAX_TRACKED_RECEIPTS = 200;

/** Default state-file location; tests pass their own path. */
export const receiptStatePath = (
  env: NodeJS.ProcessEnv = process.env
): string =>
  join(
    env.XDG_STATE_HOME ?? join(homedir(), '.local', 'state'),
    'zero-memory',
    'session-receipts.json'
  );

export const loadReceiptState = (path: string): ReceiptStateFile => {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as ReceiptStateFile;
  } catch {
    return {};
  }
};

const saveReceiptState = (path: string, state: ReceiptStateFile): void => {
  const entries = Object.entries(state)
    .sort(([, a], [, b]) => b.at - a.at)
    .slice(0, MAX_TRACKED_RECEIPTS);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(Object.fromEntries(entries), null, 2));
};

/** Adds one ingest response's `memories_created` to the session's total. */
export const recordCapturedMemories = (
  path: string,
  sessionId: string,
  memoriesCreated: number,
  now: number = Date.now()
): void => {
  const state = loadReceiptState(path);
  const existing = state[sessionId];
  state[sessionId] = {
    captured: (existing?.captured ?? 0) + memoriesCreated,
    first_capture_at: existing?.first_capture_at ?? now,
    receipted: existing?.receipted ?? false,
    at: now,
  };
  saveReceiptState(path, state);
};

/**
 * Claims the one receipt a session gets: returns the accumulated state and
 * marks the session receipted, or null when a receipt was already emitted
 * (a re-fired SessionEnd — e.g. after a resume — stays silent).
 */
export const claimReceipt = (
  path: string,
  sessionId: string,
  now: number = Date.now()
): SessionReceiptState | null => {
  const state = loadReceiptState(path);
  const existing = state[sessionId];
  if (existing?.receipted) {
    return null;
  }
  const claimed: SessionReceiptState = {
    captured: existing?.captured ?? 0,
    ...(existing?.first_capture_at !== undefined && {
      first_capture_at: existing.first_capture_at,
    }),
    receipted: true,
    at: now,
  };
  state[sessionId] = claimed;
  saveReceiptState(path, state);
  return claimed;
};
