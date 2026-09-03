/**
 * Offline briefing: the shape of a cached briefing and how it is rendered when
 * served from the cache. Pure — the file-backed cache IO that produces and
 * stores these entries lives in the IO adapters (`@workspace/client-runtime`),
 * which import the type and TTL from here.
 */

export interface BriefCacheEntry {
  /** Project root the briefing was built for (the hook's cwd). */
  cwd: string;
  /** The briefing context exactly as it was injected (loops + sections). */
  context: string;
  /** When the briefing was delivered (epoch ms) — the TTL anchor. */
  cached_at: number;
}

/** A briefing older than this is worse than none — stale context misleads. */
export const DEFAULT_BRIEF_CACHE_TTL_DAYS = 7;

export const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The offline frame: an explicit staleness header ahead of the cached
 * briefing, so the agent (and the user it relays to) can weigh the context
 * accordingly. Complements the health trailer's outage warning.
 *
 * `cause` names WHY the live briefing could not be served — the classified
 * server state, not a blanket "unreachable" (which is a lie when the server is
 * actually reachable but the briefing call itself failed). Defaults to the
 * unreachable case for callers that cannot classify.
 */
export const renderOfflineBriefing = (
  entry: BriefCacheEntry,
  now: number = Date.now(),
  cause: string = 'the zero-memory server is unreachable'
): string => {
  const ageDays = Math.max(0, Math.round((now - entry.cached_at) / DAY_MS));
  const age = ageDays === 0 ? 'today' : `${ageDays}d ago`;
  return (
    `⚠️ OFFLINE briefing: ${cause}, so this is the last cached briefing (from ` +
    `${new Date(entry.cached_at).toISOString()}, ${age}). It may be stale — ` +
    `loops shown may be closed.\n\n${entry.context}`
  );
};
