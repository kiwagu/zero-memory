import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import type { BriefTail } from '@workspace/client-core';
import { startsNewEpoch } from '@workspace/client-core';

/**
 * Per-session briefing state shared by the SessionStart and UserPromptSubmit
 * hooks, persisted in the XDG state directory (same home as the stop hook's
 * transcript offsets). The SessionStart hook records which `mem_` ids it
 * injected; the prompt hook filters those out of its pack and flips
 * `task_briefed` so a session gets exactly one task briefing — resumed
 * sessions keep their `session_id`, so the guarantee survives resume/compact.
 */

export interface SessionBriefState {
  /**
   * `mem_` ids a briefing injected into the CURRENT context window — what the
   * task briefing leaves out so nothing arrives twice. Cleared at a boundary
   * with everything else the window carried: after a compaction those
   * memories are no longer in view, so filtering them would withhold exactly
   * what the new window lacks.
   */
  injected_ids: string[];
  /** Set once the first substantive prompt has been briefed. */
  task_briefed: boolean;
  /**
   * Which context window this session is on. Bumped when the client reports a
   * boundary (compaction, a cleared conversation) on its session-start event —
   * everything injected into the previous window is gone, so per-window
   * one-shots re-arm here rather than staying spent for the whole session.
   */
  epoch: number;
  /**
   * The epoch whose session-start briefing actually DELIVERED the standing
   * rules. Absent while the current window has not carried them, which is the
   * state that makes the task hook render them.
   */
  rules_epoch?: number;
  /**
   * When the session started (epoch ms) — the receipt's window start. Stamped
   * by the SessionStart hook before any server call, so it survives a failed
   * briefing; a resume keeps the FIRST stamp (the true session start).
   */
  started_at?: number;
  /**
   * The server-minted thread token of THIS conversation, as the last briefing
   * that identified it reported. It lives here — keyed by session id — and
   * nowhere else: a token kept per PROJECT is shared by every session open in
   * that repo, so the newest briefing overwrites it and the other sessions
   * start quoting a stranger's conversation. Absent until a briefing resolves
   * one, which is the honest state to render (no token beats a wrong one).
   */
  thread?: string;
  /**
   * The remainder of this window's first briefing — what did not fit and is
   * still queued to ride along with later messages, one memory per message,
   * until `planTailChunk` (client-core) drains it. It is a property of the
   * context WINDOW, not of the session as a whole: `stampSessionStart` drops
   * it exactly where it drops `rules_epoch`, on an epoch boundary, because a
   * window that lost its context earns a fresh briefing, not the previous
   * window's leftovers.
   */
  tail?: BriefTail;
  /** Last update (epoch ms) — the pruning key. */
  at: number;
}

export type BriefStateFile = Record<string, SessionBriefState>;

/** Oldest entries beyond this are pruned on save (state must not grow forever). */
export const MAX_TRACKED_SESSIONS = 200;

/** Default state-file location; tests pass their own path. */
export const briefStatePath = (env: NodeJS.ProcessEnv = process.env): string =>
  join(
    env.XDG_STATE_HOME ?? join(homedir(), '.local', 'state'),
    'zero-memory',
    'session-briefs.json'
  );

export const loadBriefState = (path: string): BriefStateFile => {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    // Every reader indexes the result by session id and every writer assigns
    // into it, so a file that parses to anything but a plain object — a
    // literal `null`, an array, a string — would throw on every hook of every
    // session. It is treated as the empty state it effectively is.
    return typeof parsed === 'object' &&
      parsed !== null &&
      !Array.isArray(parsed)
      ? (parsed as BriefStateFile)
      : {};
  } catch {
    return {};
  }
};

const saveBriefState = (path: string, state: BriefStateFile): void => {
  const entries = Object.entries(state)
    .sort(([, a], [, b]) => b.at - a.at)
    .slice(0, MAX_TRACKED_SESSIONS);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(Object.fromEntries(entries), null, 2));
};

/**
 * The optional fields every writer must carry over, in ONE place. Each writer
 * rebuilds the whole entry, so a field listed in only some of them is silently
 * dropped by the others — that is how a session loses state it never gave up.
 * `keepWindowState: false` is the one deliberate exception: at an epoch
 * boundary, every field scoped to the outgoing context window — currently
 * `rules_epoch` and `tail` — is dropped rather than carried over, while
 * everything else here still is. A future writer adding a THIRD per-window
 * field belongs on this same flag, not a new parameter.
 */
const preserved = (
  existing: SessionBriefState | undefined,
  keepWindowState = true
): Partial<SessionBriefState> => ({
  ...(keepWindowState &&
    existing?.rules_epoch !== undefined && {
      rules_epoch: existing.rules_epoch,
    }),
  ...(existing?.started_at !== undefined && {
    started_at: existing.started_at,
  }),
  ...(existing?.thread !== undefined && { thread: existing.thread }),
  ...(keepWindowState &&
    existing?.tail !== undefined && { tail: existing.tail }),
});

/**
 * Records what the session-start briefing injected. Re-fired on resume with
 * the same `session_id`: ids are merged and `task_briefed` survives.
 */
export const recordSessionBriefing = (
  path: string,
  sessionId: string,
  injectedIds: readonly string[],
  now: number = Date.now()
): void => {
  const state = loadBriefState(path);
  const existing = state[sessionId];
  state[sessionId] = {
    injected_ids: [
      ...new Set([...(existing?.injected_ids ?? []), ...injectedIds]),
    ],
    task_briefed: existing?.task_briefed ?? false,
    epoch: existing?.epoch ?? 0,
    ...preserved(existing),
    at: now,
  };
  saveBriefState(path, state);
};

/**
 * Records the thread token the server minted for THIS conversation, so the
 * per-message assertion can quote it without a network call. Called by both
 * briefings — the session-start one and the task one, which is what heals a
 * session whose start briefing never reached the server.
 */
export const recordSessionThread = (
  path: string,
  sessionId: string,
  thread: string,
  now: number = Date.now()
): void => {
  const state = loadBriefState(path);
  const existing = state[sessionId];
  state[sessionId] = {
    injected_ids: existing?.injected_ids ?? [],
    task_briefed: existing?.task_briefed ?? false,
    epoch: existing?.epoch ?? 0,
    ...preserved(existing),
    thread,
    at: now,
  };
  saveBriefState(path, state);
};

/** This conversation's own thread token, or null while none was resolved. */
export const readSessionThread = (
  path: string,
  sessionId: string
): string | null => {
  const thread = loadBriefState(path)[sessionId]?.thread;
  return typeof thread === 'string' && thread.length > 0 ? thread : null;
};

/**
 * Records that the standing rules REACHED this window — called only after the
 * session-start briefing actually emitted them. Delivery, not the attempt, is
 * what lets the task hook skip its own copy.
 */
export const markRulesDelivered = (
  path: string,
  sessionId: string,
  now: number = Date.now()
): void => {
  const state = loadBriefState(path);
  const existing = state[sessionId];
  const epoch = existing?.epoch ?? 0;
  state[sessionId] = {
    injected_ids: existing?.injected_ids ?? [],
    task_briefed: existing?.task_briefed ?? false,
    epoch,
    ...preserved(existing),
    rules_epoch: epoch,
    at: now,
  };
  saveBriefState(path, state);
};

/**
 * Stamps when a session started — called by the SessionStart hook BEFORE any
 * server call so the stamp survives a failed briefing. A re-fire (resume with
 * the same `session_id`) keeps the first stamp: the receipt window must cover
 * the whole session, not the last resume.
 */
export const stampSessionStart = (
  path: string,
  sessionId: string,
  now: number = Date.now(),
  source?: string
): void => {
  const state = loadBriefState(path);
  const existing = state[sessionId];
  // A boundary event (compaction, a cleared conversation) means the window
  // this session was briefed into is gone: the epoch advances and everything
  // scoped to a window re-arms — the task briefing included, since after a
  // compaction the task context is as absent as the rules are, and the dedup
  // list with it, or the next task briefing would filter out the very
  // memories and loops the new window no longer has.
  const boundary = startsNewEpoch(source);
  const epoch = (existing?.epoch ?? 0) + (boundary ? 1 : 0);
  state[sessionId] = {
    injected_ids: boundary ? [] : (existing?.injected_ids ?? []),
    task_briefed: boundary ? false : (existing?.task_briefed ?? false),
    epoch,
    // The thread is deliberately NOT re-armed by a boundary: compaction and
    // resume keep the client's conversation id, so the token stays this
    // conversation's own.
    ...preserved(existing, !boundary),
    started_at: existing?.started_at ?? now,
    at: now,
  };
  saveBriefState(path, state);
};

/** Flips the one-shot flag after a successful task briefing. */
export const markTaskBriefed = (
  path: string,
  sessionId: string,
  now: number = Date.now()
): void => {
  const state = loadBriefState(path);
  const existing = state[sessionId];
  state[sessionId] = {
    injected_ids: existing?.injected_ids ?? [],
    task_briefed: true,
    epoch: existing?.epoch ?? 0,
    ...preserved(existing),
    at: now,
  };
  saveBriefState(path, state);
};

/**
 * Records the remainder of this window's first briefing — the queue
 * `planTailChunk` (client-core) hands back one memory at a time on every
 * later message. This is the only writer that sets `tail`; every other
 * writer in this file must carry it forward untouched, which is what
 * `preserved()` is for.
 */
export const recordBriefTail = (
  path: string,
  sessionId: string,
  tail: BriefTail,
  now: number = Date.now()
): void => {
  const state = loadBriefState(path);
  const existing = state[sessionId];
  state[sessionId] = {
    injected_ids: existing?.injected_ids ?? [],
    task_briefed: existing?.task_briefed ?? false,
    epoch: existing?.epoch ?? 0,
    ...preserved(existing),
    tail,
    at: now,
  };
  saveBriefState(path, state);
};

/**
 * This window's queued briefing remainder, or null while none is queued.
 * Guards the shape cheaply (an array `memories`) rather than trusting the
 * disk outright — the file's own precedent, `readSessionThread` above,
 * already does this for `thread`. A stale write from an older watcher or a
 * truncated save could otherwise hand back a `tail` with no `memories`, and
 * the per-message drain would throw on every message of that session
 * instead of just skipping a queue that was never really there.
 */
export const readBriefTail = (
  path: string,
  sessionId: string
): BriefTail | null => {
  const tail = loadBriefState(path)[sessionId]?.tail;
  return Array.isArray(tail?.memories) ? tail : null;
};

/**
 * Drops the queued remainder once it has drained to nothing — called by the
 * per-message hook when a chunk takes the last memory, or when a briefing's
 * pack leaves nothing queued. Rebuilding the entry without `tail` (rather
 * than routing it through `preserved()`) is deliberate here: this writer's
 * entire job is to make that one field stop being carried forward, so it
 * must not re-add the field it exists to drop.
 */
export const clearBriefTail = (
  path: string,
  sessionId: string,
  now: number = Date.now()
): void => {
  const state = loadBriefState(path);
  const existing = state[sessionId];
  if (!existing) return;
  const { tail: _tail, ...rest } = existing;
  state[sessionId] = { ...rest, at: now };
  saveBriefState(path, state);
};
