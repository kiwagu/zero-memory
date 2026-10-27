import {
  MCP_SESSION_IDLE_TTL_MS,
  type IMcpSessionStore,
  type McpSessionRecord,
} from './mcp-session.store.js';
import {
  evictSessionsOverCap,
  evictUserSessionsOverCap,
  maxSessionsFromEnv,
  maxSessionsPerUserFromEnv,
} from './session-cap.js';

const SWEEP_INTERVAL_MS = 60 * 1000;

/**
 * Sessions in this process's memory: the store for a long-lived server.
 * Both caps bound the map, because an authenticated client that opens
 * sessions in a loop would otherwise grow it without limit.
 */
export class InMemoryMcpSessionStore implements IMcpSessionStore {
  readonly #sessions = new Map<string, McpSessionRecord>();
  readonly #maxSessions = maxSessionsFromEnv();
  readonly #maxSessionsPerUser = maxSessionsPerUserFromEnv();

  constructor() {
    setInterval(() => this.#sweep(), SWEEP_INTERVAL_MS).unref?.();
  }

  async open(record: McpSessionRecord): Promise<string[]> {
    this.#sessions.set(record.sessionId, { ...record });
    const evicted = [
      ...evictUserSessionsOverCap(
        this.#sessions,
        record.ownerUserEntityId,
        this.#maxSessionsPerUser
      ),
      ...evictSessionsOverCap(this.#sessions, this.#maxSessions),
    ];
    return evicted.map(([id]) => id);
  }

  async resume(
    sessionId: string,
    ownerUserEntityId: string,
    at: number
  ): Promise<McpSessionRecord | undefined> {
    const found = this.#sessions.get(sessionId);
    if (
      !found ||
      found.ownerUserEntityId !== ownerUserEntityId ||
      this.#idledOut(found)
    ) {
      return undefined;
    }
    found.lastSeenAt = at;
    return { ...found };
  }

  async attachScope(sessionId: string, scope: string): Promise<void> {
    const found = this.#sessions.get(sessionId);
    if (found) {
      found.defaultScope = scope;
    }
  }

  async close(sessionId: string, ownerUserEntityId: string): Promise<boolean> {
    const found = this.#sessions.get(sessionId);
    if (!found || found.ownerUserEntityId !== ownerUserEntityId) {
      return false;
    }
    this.#sessions.delete(sessionId);
    return true;
  }

  #idledOut(record: McpSessionRecord): boolean {
    return record.lastSeenAt < Date.now() - MCP_SESSION_IDLE_TTL_MS;
  }

  #sweep(): void {
    for (const [sessionId, record] of this.#sessions) {
      if (this.#idledOut(record)) {
        this.#sessions.delete(sessionId);
      }
    }
  }
}
