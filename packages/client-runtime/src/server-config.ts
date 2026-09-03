import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { createLogger } from '@workspace/logger';

/**
 * WHICH zero-memory server this machine talks to — one persisted answer, read
 * by every client path (the watch daemon, the hook commands, `status`, and the
 * installers that register the MCP endpoint with an editor).
 *
 * The address used to be spread across a baked-in hostname, two differently
 * named env vars (`ZM_URL` was the other; it is gone, not aliased) and whatever
 * the installer had written into the editor's MCP registration. Those could
 * disagree without anything saying so — the classic failure was interactive
 * tools on one server while the briefing hooks still talked to another, with
 * both halves reporting themselves healthy. A single file the installer writes
 * and every reader reads makes that divergence impossible to create by
 * accident.
 *
 *   ~/.config/zero-memory/config.json   {"serverUrl": "https://…/mcp"}
 *
 * Precedence: ZM_SERVER_URL (a deliberate, scripted override — CI, e2e, a
 * one-off session) > the persisted config > NOTHING. There is deliberately no
 * built-in default: any address we could invent is either a hostname from our
 * own network or someone else's machine on theirs, and a wrong server that
 * silently works is worse than an error that says what to run.
 */

/**
 * The local e2e sandbox stack's MCP endpoint (`--e2e` flag). A full live
 * environment that is safe to experiment against: its database is disposable
 * and gets reset by every e2e test run. Fixed, not configurable — the sandbox
 * is part of this repo's own stack, not a machine's chosen server.
 */
export const E2E_SERVER_URL = 'http://localhost:8788/mcp';

/** The value is the FULL MCP endpoint (…/mcp), never a base URL. */
export const SERVER_URL_ENV = 'ZM_SERVER_URL';

const logger = createLogger('server-config');

/** `~/.config/zero-memory/config.json`, overridable for tests and sandboxes. */
export const serverConfigPath = (): string =>
  process.env.ZM_CONFIG ||
  join(
    process.env.XDG_CONFIG_HOME || join(homedir(), '.config'),
    'zero-memory',
    'config.json'
  );

/** Raised instead of guessing an address. Carries the fix in its message. */
export class ServerNotConfiguredError extends Error {
  constructor() {
    super(
      'zero-memory: no server configured. Run `zero-memory-watcher login ' +
        '<url>` (e.g. https://memory.example.com/mcp) to store the address and ' +
        `authorize in one step, or set ${SERVER_URL_ENV} for a one-off ` +
        `override. Stored in ${serverConfigPath()}.`
    );
    this.name = 'ServerNotConfiguredError';
  }
}

/** An http(s) URL, or null — anything else is treated as unset. */
const validUrl = (raw: unknown): string | null => {
  if (typeof raw !== 'string' || raw.trim() === '') {
    return null;
  }
  try {
    const url = new URL(raw.trim());
    return url.protocol === 'http:' || url.protocol === 'https:'
      ? raw.trim()
      : null;
  } catch {
    return null;
  }
};

/**
 * A host with no path means the MCP endpoint the user meant but did not spell
 * out. Applied only where an address is ACCEPTED (login, the installers) —
 * never to a stored or exported value, so what a reader gets back is always
 * exactly what was written.
 */
export const normalizeServerUrl = (raw: string): string => {
  const url = new URL(raw.trim());
  if (url.pathname === '' || url.pathname === '/') {
    url.pathname = '/mcp';
  }
  return url.toString().replace(/\/$/, '');
};

const readConfigFile = (): Record<string, unknown> => {
  try {
    const parsed: unknown = JSON.parse(
      readFileSync(serverConfigPath(), 'utf8')
    );
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    // Absent or malformed reads as "not configured" — the caller's error says
    // how to write it, which is more useful than a parse error.
    return {};
  }
};

/** The persisted address, or null when the file is absent/malformed/empty. */
export const configuredServerUrl = (): string | null =>
  validUrl(readConfigFile().serverUrl);

/** The env override — one variable name, no aliases. */
const envServerUrl = (): string | null => validUrl(process.env[SERVER_URL_ENV]);

/**
 * Persist the address other clients (and the next session) will use. Other
 * keys in the file are preserved: this is the shared client config, not a
 * single-purpose file.
 */
export const persistServerUrl = (rawUrl: string): string => {
  const url = normalizeServerUrl(rawUrl);
  const path = serverConfigPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    `${JSON.stringify({ ...readConfigFile(), serverUrl: url }, null, 2)}\n`,
    { mode: 0o600 }
  );
  logger.info('server url persisted', { path, url });
  return url;
};

/** The address, or null when this machine has none — for callers that report
 * the state instead of failing on it (`status`, the hook trailers). */
export const resolveServerUrlOrNull = (): string | null =>
  envServerUrl() ?? configuredServerUrl();

/** The address, or a `ServerNotConfiguredError` naming the exact fix. */
export const resolveServerUrl = (): string => {
  const url = resolveServerUrlOrNull();
  if (!url) {
    throw new ServerNotConfiguredError();
  }
  return url;
};

/** Where the effective address came from — printed by `status`. */
export const serverUrlOrigin = (): 'env' | 'config' | 'none' => {
  if (envServerUrl()) return 'env';
  if (configuredServerUrl()) return 'config';
  return 'none';
};
