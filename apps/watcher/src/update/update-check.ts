import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { createLogger } from '@workspace/logger';

const logger = createLogger('update');

/** A stalled source read (e.g. a hung network mount) must not delay a
 * session start — cap the wait. */
const SOURCE_READ_TIMEOUT_MS = 1500;

const stateDir = (env: NodeJS.ProcessEnv = process.env): string =>
  join(env.XDG_STATE_HOME ?? join(homedir(), '.local', 'state'), 'zero-memory');

/** Written by the deploy scripts at install time — where this install came
 * from, which manifest to poll, and how the user updates. The env is
 * injectable so a test can point it at a state dir with no real install. */
export const originPath = (env: NodeJS.ProcessEnv = process.env): string =>
  join(stateDir(env), 'plugin-origin.json');

export interface PluginOrigin {
  source: string;
  source_manifest: string;
  installed_version: string;
  update_command: string;
}

/** A pending update: what is installed, what the source ships, how to get it. */
export interface UpdateNotice {
  installed: string;
  latest: string;
  command: string;
}

/** Parses the origin file's JSON; null when absent or malformed. */
export const parseOrigin = (raw: string): PluginOrigin | null => {
  try {
    const o = JSON.parse(raw) as PluginOrigin;
    return typeof o.source === 'string' &&
      typeof o.source_manifest === 'string' &&
      typeof o.installed_version === 'string' &&
      typeof o.update_command === 'string'
      ? o
      : null;
  } catch {
    return null;
  }
};

/**
 * Compares two `x.y.z` versions numerically: 1 when a > b, -1 when a < b,
 * 0 when equal, null when either does not parse (never notify on garbage).
 */
export const compareVersions = (a: string, b: string): number | null => {
  const parse = (v: string): number[] | null => {
    const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v.trim());
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
  };
  const pa = parse(a);
  const pb = parse(b);
  if (!pa || !pb) return null;
  for (let i = 0; i < 3; i++) {
    const da = pa[i] ?? 0;
    const db = pb[i] ?? 0;
    if (da !== db) return da > db ? 1 : -1;
  }
  return 0;
};

/** Reads a file with a hard timeout; null on timeout or any error. */
const readWithTimeout = async (path: string): Promise<string | null> => {
  try {
    return await Promise.race([
      readFile(path, 'utf8'),
      new Promise<null>((resolve) => {
        const timer = setTimeout(() => resolve(null), SOURCE_READ_TIMEOUT_MS);
        timer.unref?.();
      }),
    ]);
  } catch {
    return null;
  }
};

const manifestVersion = (raw: string): string | null => {
  try {
    const m = JSON.parse(raw) as { version?: unknown };
    return typeof m.version === 'string' ? m.version : null;
  } catch {
    return null;
  }
};

/**
 * One update check: compare the version ACTUALLY RUNNING with the source
 * bundle's and return the pending update, or null to stay silent — no origin
 * recorded, source unreachable (a flaky mount must never break a session
 * start), or up to date. Deliberately STATELESS: the notice is re-delivered
 * on every session start until the update is installed — its user-facing
 * copy is one short line, and a suppressed-but-unseen notice (the earlier
 * TTL design) is worse than a repeated one. Never throws.
 *
 * The running version is PASSED IN, not read from the origin file. That file
 * records what a deploy script installed once; it says nothing about a binary
 * replaced since, so comparing against it announces upgrades that are already
 * installed and hides ones that are not. The caller resolves the running version
 * (the binary knows its own), which also keeps this module free of that
 * dependency and the comparison trivially testable.
 */
export const checkForUpdate = async (
  runningVersion: string
): Promise<UpdateNotice | null> => {
  try {
    let raw: string;
    try {
      raw = readFileSync(originPath(), 'utf8');
    } catch {
      return null; // nothing recorded — not a deploy-managed install.
    }
    const origin = parseOrigin(raw);
    if (!origin) {
      logger.warn('update check skipped: malformed origin file');
      return null;
    }

    const sourceRaw = await readWithTimeout(origin.source_manifest);
    if (sourceRaw === null) {
      logger.info('update check: source unreachable', {
        source: origin.source,
      });
      return null;
    }
    const latest = manifestVersion(sourceRaw);
    const installed = runningVersion;
    if (!latest || compareVersions(latest, installed) !== 1) {
      logger.info('update check: up to date', { installed, latest });
      return null;
    }

    logger.info('update check: update available', { installed, latest });
    return { installed, latest, command: origin.update_command };
  } catch (error) {
    logger.warn('update check error (ignored)', { error: String(error) });
    return null;
  }
};

/** One short user-facing line — shown verbatim in chat via systemMessage. */
export const noticeChatLine = (n: UpdateNotice): string =>
  `⬆️ zero-memory plugin update: v${n.latest} available (installed v${n.installed}). ` +
  `Update:  ${n.command}  — then fully reload Claude Code and start a new conversation.`;

/** Supporting context for the model — the user already sees the chat line. */
export const noticeContext = (n: UpdateNotice): string =>
  `The user has been shown a zero-memory plugin update notice in the chat ` +
  `(v${n.latest} available, v${n.installed} installed). If they ask for help ` +
  `updating, run:\n    ${n.command}\nthen have them fully reload Claude Code ` +
  `and start a NEW conversation.`;
