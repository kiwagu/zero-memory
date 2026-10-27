import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * The files this machine keeps its client state in: every hook runs as its
 * own short-lived process, so what one firing learned reaches the next only
 * through a file. They share one home and one discipline — a file that is
 * missing or damaged reads as "nothing recorded yet", never as an error, since
 * a state problem must not sink the hook that reads it.
 */

/** `$XDG_STATE_HOME/zero-memory/<name>`, under `~/.local/state` without it. */
export const stateFilePath = (
  name: string,
  env: NodeJS.ProcessEnv = process.env
): string =>
  join(
    env.XDG_STATE_HOME ?? join(homedir(), '.local', 'state'),
    'zero-memory',
    name
  );

/**
 * A keyed state file's entries. Missing, unreadable, torn mid-write, or
 * holding anything but a JSON object (a literal `null`, an array, a string):
 * all read as empty, because every reader indexes the result by key and every
 * writer assigns into it.
 */
export const loadStateRecord = <T>(path: string): Record<string, T> => {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    return typeof parsed === 'object' &&
      parsed !== null &&
      !Array.isArray(parsed)
      ? (parsed as Record<string, T>)
      : {};
  } catch {
    return {};
  }
};

/** Writes `value` as the whole file (`indent` as JSON.stringify takes it). */
export const writeStateFile = (
  path: string,
  value: unknown,
  indent?: number
): void => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, indent));
};

/**
 * Writes a keyed state file keeping only the `cap` entries with the newest
 * `stamp`, so a file that gains an entry per session never grows forever.
 */
export const saveCappedStateRecord = <T>(
  path: string,
  state: Record<string, T>,
  cap: number,
  stamp: (entry: T) => number
): void =>
  writeStateFile(
    path,
    Object.fromEntries(
      Object.entries(state)
        .sort(([, a], [, b]) => stamp(b) - stamp(a))
        .slice(0, cap)
    ),
    2
  );
