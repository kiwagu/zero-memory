/**
 * One metered unit of work, append-only. A usage event carries only counters
 * and identifiers — never memory content — so the metering / product-analytics
 * store (public.usage_events) stays free of user data and safe to aggregate.
 *
 * `session_briefing` is the SessionStart briefing path. `recall_used` is the
 * recall usefulness signal: a recalled memory that was actually used —
 * emitted in-band when a `remember` supersedes/derives from a recalled id, or
 * out-of-band by the watcher's usefulness judge. The others map to the
 * extraction, embedding, MCP-dispatcher, and ingest emit points.
 */
export type UsageEventType =
  | 'llm_extraction'
  | 'embedding'
  | 'mcp_tool_call'
  | 'ingest_chunk'
  | 'session_briefing'
  | 'recall_used';

/** How `quantity` is counted: whole events, or token volume. */
export type UsageUnit = 'count' | 'tokens';

export interface UsageEvent {
  /** What was consumed. */
  eventType: UsageEventType;
  /** How much of it. Defaults to 1 at the adapter when omitted. */
  quantity?: number;
  /** Counting unit. Defaults to 'count' at the adapter when omitted. */
  unit?: UsageUnit;
  /**
   * Small structured context — tool name, token split, model id. Counters and
   * identifiers only; never memory content.
   */
  metadata?: Record<string, unknown> | null;
  /** Agent principal when the caller is an agent, else null. */
  agentName?: string | null;
  /**
   * Whom the work was for, when that cannot be read from the ambient request.
   *
   * Background passes run outside any request but always know whose corpus
   * they touched. Without this the row lands with no user at all, and a
   * budget checked against that owner would never actually be spent — the
   * check and the ledger would be describing different things.
   */
  subjectId?: string;
}
