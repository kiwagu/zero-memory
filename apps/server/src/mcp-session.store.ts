/**
 * What the server keeps about one MCP Streamable HTTP session between
 * requests. The protocol objects (McpServer + transport) are rebuilt for every
 * request, so a session is nothing but this record: who opened it, which
 * client it is, and which project it attached to. That is what lets the
 * session outlive the process that opened it — a process restart, or a
 * request that lands on another instance.
 */
export interface McpSessionRecord {
  sessionId: string;
  /** The usr_ id that opened the session; nobody else can resume it. */
  ownerUserEntityId: string;
  /** The client's self-declared `clientInfo.name` from initialize. */
  clientName: string | null;
  /** Project scope a caller's `project_hint` attached to this session. */
  defaultScope?: string;
  /** Epoch milliseconds of the last request. */
  lastSeenAt: number;
}

/** A session with no request for this long is gone. */
export const MCP_SESSION_IDLE_TTL_MS = 30 * 60 * 1000;

export interface IMcpSessionStore {
  /**
   * Stores a freshly initialized session, then enforces the store's caps by
   * dropping the least recently used sessions; the owner's own sessions go
   * first. Returns the ids it dropped.
   */
  open(record: McpSessionRecord): Promise<string[]>;
  /**
   * The owner's live session, its idle clock restarted at `at`. Undefined
   * when it never existed, idled out, or belongs to someone else — the three
   * are deliberately indistinguishable to the caller.
   */
  resume(
    sessionId: string,
    ownerUserEntityId: string,
    at: number
  ): Promise<McpSessionRecord | undefined>;
  /** Records the project scope the session attached to. */
  attachScope(sessionId: string, scope: string): Promise<void>;
  /** Ends the owner's session. False when there was nothing to end. */
  close(sessionId: string, ownerUserEntityId: string): Promise<boolean>;
}
