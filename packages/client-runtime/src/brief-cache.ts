import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import {
  type BriefCacheEntry,
  DAY_MS,
  DEFAULT_BRIEF_CACHE_TTL_DAYS,
} from '@workspace/client-core';

/**
 * Offline briefing cache (state-store adapter): the SessionStart hook stores
 * the last successfully delivered briefing per project, and serves it back —
 * with an explicit OFFLINE header (rendered by `@workspace/client-core`) — when
 * the server is unreachable at the next session start. Read-only resilience:
 * only the briefing (read side) is cached; writes are never buffered offline.
 * One JSON file per project under the XDG state dir.
 */

/** Default cache directory; tests pass their own. */
export const briefCacheDir = (env: NodeJS.ProcessEnv = process.env): string =>
  join(
    env.XDG_STATE_HOME ?? join(homedir(), '.local', 'state'),
    'zero-memory',
    'brief-cache'
  );

/**
 * One file per project, keyed by the FULL cwd path (basenames collide across
 * checkouts) — encoded the way Claude Code names its project dirs.
 */
export const briefCacheFile = (dir: string, cwd: string): string =>
  join(dir, `${cwd.replace(/[^a-zA-Z0-9]/g, '-')}.json`);

/** Stores the last delivered briefing for `cwd`. Best-effort: never throws. */
export const writeBriefCache = (
  dir: string,
  cwd: string,
  context: string,
  now: number = Date.now()
): void => {
  try {
    mkdirSync(dir, { recursive: true });
    const entry: BriefCacheEntry = { cwd, context, cached_at: now };
    writeFileSync(briefCacheFile(dir, cwd), JSON.stringify(entry, null, 2));
  } catch {
    // best-effort: a failed cache write only costs offline resilience.
  }
};

/**
 * The cached briefing for `cwd`, or null when there is none, it is corrupt,
 * or it is older than the TTL (a stale briefing misleads more than silence).
 */
export const readBriefCache = (
  dir: string,
  cwd: string,
  now: number = Date.now(),
  ttlDays: number = DEFAULT_BRIEF_CACHE_TTL_DAYS
): BriefCacheEntry | null => {
  try {
    const entry = JSON.parse(
      readFileSync(briefCacheFile(dir, cwd), 'utf8')
    ) as BriefCacheEntry;
    if (
      typeof entry.context !== 'string' ||
      typeof entry.cached_at !== 'number' ||
      entry.context.length === 0
    ) {
      return null;
    }
    return now - entry.cached_at <= ttlDays * DAY_MS ? entry : null;
  } catch {
    return null;
  }
};

/**
 * Drops the cached briefing for `cwd` — called for `.zero-memory-ignore`
 * projects so a briefing cached before the project was marked sensitive does
 * not linger on disk. Best-effort: never throws.
 */
export const clearBriefCache = (dir: string, cwd: string): void => {
  try {
    rmSync(briefCacheFile(dir, cwd), { force: true });
  } catch {
    // best-effort: an unremovable file only means the cache outlives the flag.
  }
};
