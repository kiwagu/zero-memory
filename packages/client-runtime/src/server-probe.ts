import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';
import { createAuthedTransport } from '@workspace/mcp-oauth-client';

import {
  ServerNotConfiguredError,
  resolveServerUrlOrNull,
} from './server-config.js';

/**
 * The distinct states this machine can be in relative to the zero-memory
 * server. The whole point is that a caller (a hook, a session) can tell
 * "the server is down" apart from "I am not logged in" apart from "the server
 * errored" — instead of one generic "offline" that hides the actual fix.
 */
export type ServerState =
  | 'ok'
  | 'not-configured'
  | 'server-down'
  | 'unauthenticated'
  | 'server-error'
  | 'timeout';

export interface ServerProbe {
  readonly state: ServerState;
  /** One-line human detail: what actually happened. */
  readonly detail: string;
  /** The concrete next action for this state (empty string when ok). */
  readonly fix: string;
  /**
   * The endpoint this result is ABOUT (null when none is configured). Carried
   * on the result so every report names its target: "reachable" without saying
   * reachable-to-what is what makes a machine pointed at the wrong server look
   * healthy.
   */
  readonly serverUrl: string | null;
}

/** The single, state-specific remedy — the opposite of a generic message. */
const FIX: Record<ServerState, string> = {
  ok: '',
  'not-configured': new ServerNotConfiguredError().message,
  'server-down':
    'The zero-memory server is unreachable — start or restart it, or check ' +
    'the network/mDNS resolution of the server host.',
  unauthenticated:
    'This machine is not authenticated (no valid token / refresh rejected) — ' +
    'run `zero-memory-watcher login`.',
  'server-error':
    'The server is up but errored on the request — check the server logs.',
  timeout:
    'The server did not answer in time — it may be starting or overloaded; ' +
    'retry shortly.',
};

const make = (
  state: ServerState,
  detail: string,
  serverUrl: string | null
): ServerProbe => ({
  state,
  detail,
  fix: FIX[state],
  serverUrl,
});

/** `…/mcp` → `…/healthz` (the unauthenticated liveness endpoint). */
export const healthzUrlOf = (serverUrl: string): string =>
  `${serverUrl.replace(/\/mcp\/?$/, '')}/healthz`;

const isTimeout = (error: unknown): boolean =>
  error instanceof Error &&
  (error.name === 'TimeoutError' || error.name === 'AbortError');

/** An auth failure vs a transport/server failure — the key distinction. */
const isUnauthenticated = (error: unknown): boolean =>
  error instanceof UnauthorizedError ||
  (error instanceof Error &&
    /not authenticated|unauthor|invalid_grant|invalid_token|\b401\b|login/i.test(
      error.message
    ));

/** Best-effort HTTP status pulled from an SDK error message (e.g. "… 503 …"). */
const httpStatusIn = (error: unknown): number | null => {
  const message = error instanceof Error ? error.message : String(error);
  const match = /\b(4\d\d|5\d\d)\b/.exec(message);
  return match ? Number(match[1]) : null;
};

/**
 * Liveness only — an unauthenticated `/healthz` GET. Separate from the full
 * probe because accepting an ADDRESS (login, an installer) must answer "is
 * there a zero-memory server there at all" BEFORE credentials exist: at that
 * moment "unauthenticated" is the expected state, not a failure.
 */
export const probeLiveness = async (
  serverUrl: string,
  timeoutMs = 4000
): Promise<ServerProbe> => {
  try {
    const res = await fetch(healthzUrlOf(serverUrl), {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      return res.status >= 500
        ? make('server-error', `healthz ${res.status}`, serverUrl)
        : make('server-down', `healthz ${res.status}`, serverUrl);
    }
    return make('ok', `healthz ok at ${serverUrl}`, serverUrl);
  } catch (error) {
    return isTimeout(error)
      ? make('timeout', 'healthz timed out', serverUrl)
      : make('server-down', `healthz unreachable: ${String(error)}`, serverUrl);
  }
};

/**
 * Classify the LIVE state of the zero-memory server from this machine.
 *
 * Watcher-only (no server change): a machine with no configured server is its
 * own state (nothing to probe), then a bare healthz GET decides liveness — so a
 * dead server is never misread as an auth problem — then ONE authenticated MCP
 * connect (the same OAuth path ingest/brief use, so it reflects reality)
 * classifies the credential state. Never throws; every failure maps to a state
 * with its own concrete `fix`, and every result names the endpoint it is about.
 */
export const probeServer = async (
  configuredUrl: string | null = resolveServerUrlOrNull(),
  timeoutMs = 4000
): Promise<ServerProbe> => {
  if (!configuredUrl) {
    return make('not-configured', 'no server configured on this machine', null);
  }
  const serverUrl = configuredUrl;

  // 1. Liveness — unauthenticated GET. Splits down/timeout from everything else.
  const live = await probeLiveness(serverUrl, timeoutMs);
  if (live.state !== 'ok') {
    return live;
  }

  // 2. Auth — the server is UP, so a failure here is about credentials or a
  //    server-side error, NOT liveness. Connect (initialize) then close.
  const client = new Client({
    name: 'zero-memory-status',
    version: '0.1.0',
  });
  try {
    await client.connect(createAuthedTransport(serverUrl));
    await client.close().catch(() => undefined);
    return make('ok', `reachable and authenticated at ${serverUrl}`, serverUrl);
  } catch (error) {
    await client.close().catch(() => undefined);
    if (isUnauthenticated(error)) {
      return make(
        'unauthenticated',
        `auth rejected: ${String(error)}`,
        serverUrl
      );
    }
    if (isTimeout(error)) {
      return make('timeout', 'authenticated connect timed out', serverUrl);
    }
    const status = httpStatusIn(error);
    if (status !== null && status >= 500) {
      return make('server-error', `connect ${status}`, serverUrl);
    }
    // healthz passed but the MCP connect failed for another reason: treat it as
    // a server-side problem, never as "you are unauthenticated".
    return make('server-error', `connect failed: ${String(error)}`, serverUrl);
  }
};
