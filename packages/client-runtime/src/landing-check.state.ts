import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

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
): string =>
  join(
    env.XDG_STATE_HOME ?? join(homedir(), '.local', 'state'),
    'zero-memory',
    'landing-checks.json'
  );

const load = (path: string): Record<string, Entry> => {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, Entry>)
      : {};
  } catch {
    return {};
  }
};

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
    const kept = Object.entries(state)
      .sort(([, a], [, b]) => b.checked_at - a.checked_at)
      .slice(0, MAX_ENTRIES);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(Object.fromEntries(kept), null, 2));
  } catch {
    // best-effort: losing it costs one repeated reminder.
  }
};
