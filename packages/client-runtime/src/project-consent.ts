import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';

/**
 * Per-project privacy controls for transcript INGEST — so sensitive projects
 * are never sent to the server without consent. Two independent gates:
 *   1. the Stop `ingest` hook is opt-in (wired only by `deploy-zm-claude.sh
 *      --with-ingest`, never in the default plugin);
 *   2. even when wired, a consent config decides per project (default: off,
 *      nothing captured).
 *
 * Config file (JSON) at ZM_INGEST_CONFIG or ~/.config/zero-memory/ingest.json,
 * with exactly one of `allowlist` / `denylist` (arrays of path globs; `"*"`
 * matches everything):
 *   {"allowlist": ["*"]}                    → capture every project (dev)
 *   {"allowlist": ["/home/me/work/*"]}      → capture only matching
 *   {"denylist": ["*"]}                     → capture nothing (== off)
 *   {"denylist": ["/home/me/clients/*"]}    → capture all except matching
 *   (no file / neither / both)              → off
 *
 * Per-project markers override the config, and live with the repo:
 *   .zero-memory-ignore  → NEVER capture (also skips brief, which sends the
 *                          prompt) — the sensitive-project switch;
 *   .zero-memory-allow   → capture under `allowlist` even if no glob matches.
 */
export type IngestMode = 'off' | 'allowlist' | 'denylist';

const IGNORE_MARKER = '.zero-memory-ignore';
const ALLOW_MARKER = '.zero-memory-allow';

interface IngestConfig {
  mode: IngestMode;
  patterns: string[];
}

const configPath = (): string =>
  process.env.ZM_INGEST_CONFIG ||
  join(homedir(), '.config', 'zero-memory', 'ingest.json');

/** Parse the consent config; anything malformed or absent means `off`. */
const readConfig = (): IngestConfig => {
  try {
    const raw = JSON.parse(readFileSync(configPath(), 'utf8')) as {
      allowlist?: unknown;
      denylist?: unknown;
    };
    const allow = Array.isArray(raw.allowlist)
      ? (raw.allowlist as string[])
      : null;
    const deny = Array.isArray(raw.denylist)
      ? (raw.denylist as string[])
      : null;
    // Exactly one list is meaningful; both or neither → off.
    if (allow && !deny) return { mode: 'allowlist', patterns: allow };
    if (deny && !allow) return { mode: 'denylist', patterns: deny };
    return { mode: 'off', patterns: [] };
  } catch {
    return { mode: 'off', patterns: [] };
  }
};

/** A single glob (`*` = any chars) matched against the full path AND basename. */
const globMatches = (dir: string, pattern: string): boolean => {
  if (pattern === '*') {
    return true;
  }
  const re = new RegExp(
    `^${pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`
  );
  return re.test(dir) || re.test(basename(dir));
};

const matchesAny = (dir: string, patterns: string[]): boolean =>
  patterns.some((p) => globMatches(dir, p));

/** True if `marker` exists in `dir` or any ancestor up to the filesystem root. */
const hasMarkerUpward = (dir: string, marker: string): boolean => {
  let current = dir;
  for (;;) {
    if (existsSync(join(current, marker))) {
      return true;
    }
    const parent = dirname(current);
    if (parent === current) {
      return false;
    }
    current = parent;
  }
};

/**
 * A project marked sensitive via `.zero-memory-ignore` — server-touching hooks
 * (ingest AND brief, which sends the prompt/topic) skip it entirely so nothing
 * leaves the machine for that project.
 */
export const projectIgnored = (dir: string): boolean =>
  hasMarkerUpward(dir, IGNORE_MARKER);

/** The effective ingest mode (from the config), for logging/diagnostics. */
export const ingestMode = (): IngestMode => readConfig().mode;

/**
 * Whether transcript ingest is allowed for the project at `dir`. The
 * `.zero-memory-ignore` marker always wins; otherwise the config mode decides.
 */
export const ingestAllowed = (
  dir: string
): { allowed: boolean; reason: string } => {
  if (projectIgnored(dir)) {
    return { allowed: false, reason: 'project-ignored' };
  }
  const { mode, patterns } = readConfig();
  if (mode === 'off') {
    return { allowed: false, reason: 'mode-off' };
  }
  if (mode === 'allowlist') {
    return matchesAny(dir, patterns) || hasMarkerUpward(dir, ALLOW_MARKER)
      ? { allowed: true, reason: 'allowlisted' }
      : { allowed: false, reason: 'not-allowlisted' };
  }
  // denylist: capture unless a pattern matches.
  return matchesAny(dir, patterns)
    ? { allowed: false, reason: 'denylisted' }
    : { allowed: true, reason: 'denylist' };
};
