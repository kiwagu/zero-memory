import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import type { DeployedVersion } from '@workspace/client-core';
import type { ReleaseSettings } from '@workspace/contracts';

/**
 * What this machine knows about each project's production state: the setting
 * it last read, when it last asked the version url, what that url said, and
 * which versions it has already handled — so a release is recorded and told
 * once, and a url or a server that is down never makes every command wait.
 * Best-effort: a state problem never sinks a hook.
 */

export type ReleaseCheckOutcome = 'recorded' | 'rollback' | 'no-tag' | 'error';

export interface ReleaseProjectState {
  settings?: { value: ReleaseSettings | null; fetched_at: number };
  /**
   * When the setting was last asked for, saved before asking: a server that
   * accepts the connection and never answers then costs one pause, not a
   * wait on every command.
   */
  settings_attempt_at?: number;
  last_fetch_at?: number;
  /**
   * When the url last failed to answer with a version. It is asked again only
   * after `RELEASE_RETRY_MS`, and `seen` is dropped meanwhile: a version the
   * url answered before the failure never drives a record.
   */
  url_failed_at?: number;
  seen?: DeployedVersion;
  /** The version this machine last reported as production. */
  current?: string;
  handled?: Record<string, { outcome: ReleaseCheckOutcome; at: number }>;
}

/** The version url is asked at most this often per project while it answers. */
export const RELEASE_FETCH_EVERY_MS = 2 * 60 * 1000;
/** A project's setting is read again after this long. */
export const RELEASE_SETTINGS_TTL_MS = 10 * 60 * 1000;
/**
 * A version that failed, or whose tag was missing, is tried again after this
 * long; so is a version url that failed to answer.
 */
export const RELEASE_RETRY_MS = 10 * 60 * 1000;

const MAX_VERSIONS = 50;

export const releaseCheckStatePath = (
  env: NodeJS.ProcessEnv = process.env
): string =>
  join(
    env.XDG_STATE_HOME ?? join(homedir(), '.local', 'state'),
    'zero-memory',
    'release-checks.json'
  );

const load = (path: string): Record<string, ReleaseProjectState> => {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    return parsed !== null &&
      typeof parsed === 'object' &&
      !Array.isArray(parsed)
      ? (parsed as Record<string, ReleaseProjectState>)
      : {};
  } catch {
    return {};
  }
};

export const readReleaseState = (
  path: string,
  scope: string
): ReleaseProjectState => load(path)[scope] ?? {};

export const writeReleaseState = (
  path: string,
  scope: string,
  state: ReleaseProjectState
): void => {
  try {
    const handled = Object.fromEntries(
      Object.entries(state.handled ?? {})
        .sort(([, a], [, b]) => b.at - a.at)
        .slice(0, MAX_VERSIONS)
    );
    const all = load(path);
    all[scope] = { ...state, ...(state.handled ? { handled } : {}) };
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(all));
  } catch {
    // Best-effort by design.
  }
};

export const releaseHandledDue = (
  state: ReleaseProjectState,
  version: string,
  now: number = Date.now()
): boolean => {
  const handled = state.handled?.[version];
  if (!handled) return true;
  if (handled.outcome === 'recorded' || handled.outcome === 'rollback')
    return false;
  return now - handled.at >= RELEASE_RETRY_MS;
};
