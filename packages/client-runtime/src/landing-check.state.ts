import {
  loadStateRecord,
  saveCappedStateRecord,
  stateFilePath,
} from './state-file.js';

/**
 * Which squash commits this machine has already checked against the board,
 * so a landing is reminded about once — not on every shell command after it.
 *
 * Keyed by `<squash sha>#<card number>`: one squash may name several cards,
 * and each is its own question. A check the server could not answer is kept
 * too, and retried only after a pause, so a server that is down never makes
 * every command wait for a timeout. Best-effort: a state problem never sinks
 * a hook.
 */

export type LandingCheckOutcome = 'recorded' | 'reminded' | 'no-card' | 'error';

interface Entry {
  outcome: LandingCheckOutcome;
  checked_at: number;
}

/** How long a failed check waits before the next attempt. */
export const LANDING_RETRY_MS = 10 * 60 * 1000;

/** Oldest entries beyond this are dropped on write. */
const MAX_ENTRIES = 500;

export const landingCheckStatePath = (
  env: NodeJS.ProcessEnv = process.env
): string => stateFilePath('landing-checks.json', env);

const load = (path: string): Record<string, Entry> =>
  loadStateRecord<Entry>(path);

/** Whether this squash/card pair still needs asking about. */
export const landingCheckDue = (
  path: string,
  key: string,
  now: number = Date.now()
): boolean => {
  const entry = load(path)[key];
  if (!entry) return true;
  return (
    entry.outcome === 'error' && now - entry.checked_at >= LANDING_RETRY_MS
  );
};

/**
 * When this squash/card pair was last asked about, or undefined if never. A
 * caller with less time than work asks the never-asked first, then the
 * longest-waiting, so a stalled server cannot starve the same pairs forever.
 */
export const landingCheckedAt = (
  path: string,
  key: string
): number | undefined => load(path)[key]?.checked_at;

/** Record what a check found. Best-effort. */
export const recordLandingCheck = (
  path: string,
  key: string,
  outcome: LandingCheckOutcome,
  now: number = Date.now()
): void => {
  try {
    const state = load(path);
    state[key] = { outcome, checked_at: now };
    saveCappedStateRecord(
      path,
      state,
      MAX_ENTRIES,
      (entry) => entry.checked_at
    );
  } catch {
    // best-effort: losing it costs one repeated reminder.
  }
};
