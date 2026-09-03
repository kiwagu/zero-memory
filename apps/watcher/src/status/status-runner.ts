import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { createLogger } from '@workspace/logger';

import {
  probeServer,
  resolveServerUrlOrNull,
  serverUrlOrigin,
  type ServerProbe,
  type ServerState,
} from '@workspace/client-runtime';

import { hookClient, type HookClient } from '../hook-client.js';
import {
  checkForUpdate,
  noticeChatLine,
  noticeContext,
} from '../update/update-check.js';
import { resolveVersion } from '../version/version-runner.js';

const logger = createLogger('status');

/** How long a probe result is trusted before re-probing (env override). */
const DEFAULT_TTL_MS = 30_000;
/** A down/slow server must not hang the prompt — cap the probe wait. */
const PROBE_TIMEOUT_MS = 3000;

const ttlMs = (): number => {
  const raw = Number(process.env.ZM_HEALTH_TTL_MS);
  return Number.isInteger(raw) && raw > 0 ? raw : DEFAULT_TTL_MS;
};

const cachePath = (): string =>
  join(
    process.env.XDG_STATE_HOME ?? join(homedir(), '.local', 'state'),
    'zero-memory',
    'health.json'
  );

interface HealthCache {
  ts: number;
  probe: ServerProbe;
}

const readCache = (path: string): HealthCache | null => {
  try {
    const c = JSON.parse(readFileSync(path, 'utf8')) as HealthCache;
    return typeof c.ts === 'number' &&
      c.probe &&
      typeof c.probe.state === 'string'
      ? c
      : null;
  } catch {
    return null;
  }
};

const writeCache = (path: string, cache: HealthCache): void => {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(cache));
  } catch {
    // best-effort: a failed cache write just means the next prompt re-probes.
  }
};

/**
 * True if the cached probe is still fresh for `now` AND is about the server
 * this machine talks to NOW: re-pointing at another instance must never be
 * answered from the previous one's verdict, which is how a machine reports
 * itself healthy while talking to a server it no longer uses.
 */
export const isFresh = (
  cache: HealthCache | null,
  now: number,
  serverUrl: string | null = resolveServerUrlOrNull()
): boolean =>
  cache !== null &&
  now - cache.ts < ttlMs() &&
  (cache.probe.serverUrl ?? null) === serverUrl;

/** The classified probe, honoring the short freshness cache. */
const currentProbe = async (now: number): Promise<ServerProbe> => {
  const path = cachePath();
  const cache = readCache(path);
  const serverUrl = resolveServerUrlOrNull();
  if (isFresh(cache, now, serverUrl)) return cache!.probe;
  const probe = await probeServer(serverUrl, PROBE_TIMEOUT_MS);
  writeCache(path, { ts: now, probe });
  return probe;
};

/** How often the update loop rechecks (env override, default hourly). Recurs
 * within a session so a notice missed at SessionStart still surfaces, without
 * polling the source on every prompt. */
const DEFAULT_UPDATE_TTL_MS = 60 * 60 * 1000;
const updateTtlMs = (): number => {
  const raw = Number(process.env.ZM_UPDATE_CHECK_TTL_MS);
  return Number.isInteger(raw) && raw > 0 ? raw : DEFAULT_UPDATE_TTL_MS;
};
const updateCheckPath = (): string =>
  join(
    process.env.XDG_STATE_HOME ?? join(homedir(), '.local', 'state'),
    'zero-memory',
    'update-check.json'
  );
const readUpdateCheckTs = (path: string): number => {
  try {
    const c = JSON.parse(readFileSync(path, 'utf8')) as { ts?: unknown };
    return typeof c.ts === 'number' ? c.ts : 0;
  } catch {
    return 0;
  }
};
const writeUpdateCheckTs = (path: string, ts: number): void => {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ ts }));
  } catch {
    // best-effort: a failed write just means the next prompt rechecks.
  }
};

/** State-specific headline — never a generic "offline". */
const HEADLINE: Record<Exclude<ServerState, 'ok'>, string> = {
  'not-configured': '⚠️ zero-memory has NO SERVER CONFIGURED on this machine.',
  'server-down': '⚠️ zero-memory server is UNREACHABLE (server down).',
  unauthenticated: '⚠️ zero-memory is reachable but you are NOT AUTHENTICATED.',
  'server-error': '⚠️ zero-memory server is up but returned an ERROR.',
  timeout: '⚠️ zero-memory did not answer in time (slow/starting).',
};

/**
 * The turn warning for a non-ok state: a specific headline + WHICH server the
 * verdict is about + the specific fix + a note that the memory tools
 * (mcp__zero-memory__*) are affected. The address is part of the warning
 * because "unreachable" invites restarting a server that was never the one
 * being talked to.
 */
const warningText = (probe: ServerProbe): string =>
  `${HEADLINE[probe.state as Exclude<ServerState, 'ok'>]} ` +
  (probe.serverUrl ? `Server: ${probe.serverUrl}. ` : '') +
  `${probe.fix} ` +
  'Until it recovers the memory tools (mcp__zero-memory__* — recall / ' +
  'build_context / remember) will not work this turn; tell the user plainly ' +
  `which state it is in (${probe.state}) and what to do. Rechecks each prompt.`;

/**
 * `status --json`: print the classified probe to STDOUT (one line of JSON) so a
 * session or script can poll the exact server state on demand — not a hook.
 * It carries the endpoint and where that endpoint came from (`env` override vs
 * the persisted config), which is what makes a machine pointed at the wrong
 * instance diagnosable instead of merely "reachable".
 */
export const runStatusJson = async (): Promise<void> => {
  const probe = await probeServer(resolveServerUrlOrNull(), PROBE_TIMEOUT_MS);
  const origin = serverUrlOrigin();
  process.stdout.write(JSON.stringify({ ...probe, origin }) + '\n');
  logger.info('status --json', {
    state: probe.state,
    serverUrl: probe.serverUrl,
    origin,
  });
};

/**
 * `status` — a UserPromptSubmit trailer: on each prompt, classify the
 * zero-memory server's state (cached for ZM_HEALTH_TTL_MS, default 30s, so
 * rapid prompts don't re-probe) and, when it is NOT ok, inject a state-specific
 * warning so the user learns the exact problem (down vs not-authenticated vs
 * server-error) and its fix within a turn — instead of a generic "offline"
 * after context has drifted. It also runs the plugin-update loop (rechecked at
 * most hourly). Silent when healthy and up to date; both signals share the one
 * hook frame. Never throws.
 */
export const runStatus = async (
  adapter: HookClient = hookClient()
): Promise<void> => {
  try {
    const now = Date.now();
    let event =
      adapter.kind === 'cursor' ? 'beforeSubmitPrompt' : 'UserPromptSubmit';
    try {
      const input = await adapter.readInput();
      if (input.hookEventName) {
        event = input.hookEventName;
      }
    } catch {
      // ignore a malformed/empty payload — default to the prompt-submit event.
    }

    const probe = await currentProbe(now);

    // Plugin-update loop: recheck at most ~hourly (recurs within a session so a
    // notice missed at SessionStart still surfaces, without polling every
    // prompt). The chat line rides systemMessage; supporting model context
    // rides additionalContext.
    let updateContext: string | null = null;
    let updateChatLine: string | undefined;
    const upath = updateCheckPath();
    if (now - readUpdateCheckTs(upath) >= updateTtlMs()) {
      writeUpdateCheckTs(upath, now);
      const notice = await checkForUpdate(resolveVersion().version);
      if (notice) {
        updateContext = noticeContext(notice);
        updateChatLine = noticeChatLine(notice);
      }
    }

    // A hook may print only ONE frame — combine the state warning and the
    // update notice into it and emit once.
    const context = [
      probe.state === 'ok' ? null : warningText(probe),
      updateContext,
    ]
      .filter((part): part is string => part !== null)
      .join('\n\n');
    if (context) {
      adapter.emitTurnContext(event, context, updateChatLine);
    }
    logger.info('status hook fired', {
      state: probe.state,
      serverUrl: probe.serverUrl,
      detail: probe.detail,
      update: updateChatLine ? 'notice' : 'none',
      client: adapter.kind,
    });
  } catch (error) {
    logger.warn('status hook error (ignored)', { error: String(error) });
  }
};
