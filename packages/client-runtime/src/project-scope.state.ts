import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

/**
 * Cross-session persistence of the RESOLVED project scope per repo root — the
 * client-side half of the project handshake. The session briefing resolves the
 * project deterministically (the hook sends the repo root, the server answers
 * with the canonical scope); persisting that answer lets later sessions open
 * with the trusted identity even before any server call (e.g. the offline
 * briefing still prints the PROJECT line), and survives folder moves one
 * session behind (a miss re-derives and re-records).
 *
 * One JSON map keyed by the resolved repo-root path. Best-effort everywhere:
 * a state problem must never sink a briefing.
 */

interface ProjectScopeEntry {
  scope: string;
  updated_at: number;
}

type ProjectScopeState = Record<string, ProjectScopeEntry>;

/** Oldest entries beyond this cap are dropped on write (state stays small). */
const MAX_ENTRIES = 200;

/** Default state file; tests pass their own. */
export const projectScopeStatePath = (
  env: NodeJS.ProcessEnv = process.env
): string =>
  join(
    env.XDG_STATE_HOME ?? join(homedir(), '.local', 'state'),
    'zero-memory',
    'project-scopes.json'
  );

const load = (path: string): ProjectScopeState => {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as ProjectScopeState;
    return typeof parsed === 'object' && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
};

/**
 * Records the server-resolved scope for a repo root. Best-effort.
 *
 * SCOPE ONLY, deliberately. A conversation's thread token used to be kept here
 * too, and that was wrong for a reason worth remembering: a repo hosts several
 * sessions at once, so one slot per project means the newest briefing
 * overwrites it and every other session quotes a stranger's conversation. The
 * token is per-conversation state and lives with the session — see
 * `recordSessionThread`. What IS shared per repo is the project identity, and
 * that is what this file keeps.
 */
export const recordProjectScope = (
  path: string,
  rootPath: string,
  scope: string,
  now: number = Date.now()
): void => {
  try {
    const state = load(path);
    state[rootPath] = { scope, updated_at: now };
    const entries = Object.entries(state)
      .sort(([, a], [, b]) => b.updated_at - a.updated_at)
      .slice(0, MAX_ENTRIES);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(Object.fromEntries(entries), null, 2));
  } catch {
    // best-effort: losing the persist only costs the offline PROJECT line.
  }
};

/** The last server-resolved scope for a repo root, or null. */
export const readProjectScope = (
  path: string,
  rootPath: string
): string | null => {
  const entry = load(path)[rootPath];
  return typeof entry?.scope === 'string' && entry.scope.length > 0
    ? entry.scope
    : null;
};
