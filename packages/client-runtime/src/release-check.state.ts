import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import type { DeployedVersion } from '@workspace/client-core';
import type { ReleaseSettings } from '@workspace/contracts';

/**
 * What this machine knows about each project's production state: the setting
 * it last read, when it last asked the version url, what that url said, and
 * which versions each checkout of the project has already handled — so a
 * release is recorded and told once per checkout, and a url or a server that
 * is down never makes every command wait. Best-effort: a state problem never
 * sinks a hook.
 */

export type ReleaseCheckOutcome = 'recorded' | 'rollback' | 'no-tag' | 'error';

/**
 * What one checkout of a project did with the states it saw. Which cards a
 * state carries is decided by that checkout's own git, so two checkouts of
 * one project each reconcile their own landings.
 */
export interface ReleaseCheckoutState {
  /** The version this checkout last reported as production. */
  current?: string;
  handled?: Record<string, { outcome: ReleaseCheckOutcome; at: number }>;
}

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
  /** Keyed by the checkout's project hint (its repository root). */
  checkouts?: Record<string, ReleaseCheckoutState>;
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
const MAX_CHECKOUTS = 20;

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

/** When a checkout last handled a version: the newest checkouts are kept. */
const lastHandled = (checkout: ReleaseCheckoutState): number =>
  Math.max(0, ...Object.values(checkout.handled ?? {}).map(({ at }) => at));

/**
 * Writes a project's state. The checkouts it names replace theirs, and the
 * others stay as the file has them: a check writes only its own checkout, so
 * two checkouts checking at once do not drop each other's record.
 */
export const writeReleaseState = (
  path: string,
  scope: string,
  state: ReleaseProjectState
): void => {
  try {
    const all = load(path);
    const checkouts = Object.entries({
      ...all[scope]?.checkouts,
      ...state.checkouts,
    })
      .map(([key, checkout]): [string, ReleaseCheckoutState] => [
        key,
        {
          ...checkout,
          handled: Object.fromEntries(
            Object.entries(checkout.handled ?? {})
              .sort(([, a], [, b]) => b.at - a.at)
              .slice(0, MAX_VERSIONS)
          ),
        },
      ])
      .filter(([, checkout]) => lastHandled(checkout) > 0)
      .sort(([, a], [, b]) => lastHandled(b) - lastHandled(a))
      .slice(0, MAX_CHECKOUTS);
    const { checkouts: _named, ...project } = state;
    all[scope] = {
      ...project,
      ...(checkouts.length > 0
        ? { checkouts: Object.fromEntries(checkouts) }
        : {}),
    };
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(all));
  } catch {
    // Best-effort by design.
  }
};

export const releaseHandledDue = (
  checkout: ReleaseCheckoutState,
  version: string,
  now: number = Date.now()
): boolean => {
  const handled = checkout.handled?.[version];
  if (!handled) return true;
  if (handled.outcome === 'recorded' || handled.outcome === 'rollback')
    return false;
  return now - handled.at >= RELEASE_RETRY_MS;
};
