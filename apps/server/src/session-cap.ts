/**
 * Cap for the in-memory MCP session map: unbounded growth is a memory-DoS
 * vector (every authenticated client can open sessions). When the map grows
 * past the cap, the least-recently-used sessions are evicted; the caller
 * closes their transports.
 */

const DEFAULT_MAX_SESSIONS = 200;

/** Reads ZM_MAX_SESSIONS (default 200; non-positive/garbage → default). */
export const maxSessionsFromEnv = (): number => {
  const raw = process.env.ZM_MAX_SESSIONS;
  if (raw === undefined || raw === '') {
    return DEFAULT_MAX_SESSIONS;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_SESSIONS;
};

export interface CappableSession {
  lastSeenAt: number;
}

/**
 * Deletes least-recently-used entries until `sessions` fits `maxSessions`.
 * Returns the evicted entries so the caller can close their transports.
 */
export const evictSessionsOverCap = <T extends CappableSession>(
  sessions: Map<string, T>,
  maxSessions: number
): Array<[string, T]> => {
  const evicted: Array<[string, T]> = [];
  while (sessions.size > maxSessions) {
    let oldestId: string | undefined;
    let oldest: T | undefined;
    for (const [id, session] of sessions) {
      if (oldest === undefined || session.lastSeenAt < oldest.lastSeenAt) {
        oldestId = id;
        oldest = session;
      }
    }
    if (oldestId === undefined || oldest === undefined) {
      break;
    }
    sessions.delete(oldestId);
    evicted.push([oldestId, oldest]);
  }
  return evicted;
};

const DEFAULT_MAX_SESSIONS_PER_USER = 20;

/** Reads ZM_MAX_SESSIONS_PER_USER (default 20; non-positive/garbage → default). */
export const maxSessionsPerUserFromEnv = (): number => {
  const raw = process.env.ZM_MAX_SESSIONS_PER_USER;
  if (raw === undefined || raw === '') {
    return DEFAULT_MAX_SESSIONS_PER_USER;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed > 0
    ? parsed
    : DEFAULT_MAX_SESSIONS_PER_USER;
};

export interface OwnedCappableSession extends CappableSession {
  ownerUserEntityId: string;
}

/**
 * The per-account fence in front of the global one: a caller who opens
 * sessions in a loop runs into their own cap and displaces their own oldest
 * sessions, never another user's. Returns the evicted entries so the caller
 * can close their transports.
 */
export const evictUserSessionsOverCap = <T extends OwnedCappableSession>(
  sessions: Map<string, T>,
  ownerUserEntityId: string,
  maxPerUser: number
): Array<[string, T]> => {
  const own = [...sessions].filter(
    ([, session]) => session.ownerUserEntityId === ownerUserEntityId
  );
  if (own.length <= maxPerUser) {
    return [];
  }
  own.sort(([, a], [, b]) => a.lastSeenAt - b.lastSeenAt);
  const evicted = own.slice(0, own.length - maxPerUser);
  for (const [id] of evicted) {
    sessions.delete(id);
  }
  return evicted;
};
