import { ENTITY_PREFIXES, SESSION_ID_PREFIX } from './entity-prefixes.js';

import type { MemoryAuthorKind } from './memory.schema.js';

/**
 * `agent_name` marking a memory written by the out-of-band watcher. Such memories
 * are PROVISIONAL: an authoritative source (in-band agent or human) supersedes
 * them automatically.
 */
export const WATCHER_AGENT_NAME = 'watcher';

/**
 * `agent_name` marking a memory LLM-extracted from repository sources (docs,
 * git history) by the bootstrap path. Provisional like the watcher's writes —
 * the extractor is the same, so the trust tier is the same — but kept
 * distinct so audits can tell a bootstrap harvest from live-session capture.
 */
export const BOOTSTRAP_AGENT_NAME = 'bootstrap';

/**
 * `client` tag on the ingest-log ledger for a repo-bootstrap run. Distinct
 * from the watcher's transcript rows and from `zm-import`, so each path's
 * idempotency keys never collide and stay separately auditable.
 */
export const BOOTSTRAP_CLIENT = 'zm-bootstrap';

/**
 * `source.kind` stamped on a bootstrap-extracted memory's provenance jsonb.
 * Unlike `import` (curated native memories, authoritative), a `bootstrap`
 * memory is machine-extracted and stays provisional.
 */
export const BOOTSTRAP_SOURCE_KIND = 'bootstrap';

/**
 * True for agent names whose writes are PROVISIONAL (lowest authority tier):
 * out-of-band machine extraction — the watcher's transcript capture and the
 * repo-bootstrap harvest. An authoritative in-band or human memory supersedes
 * them automatically.
 */
export const isProvisionalAgentName = (name: string | null): boolean =>
  name === WATCHER_AGENT_NAME || name === BOOTSTRAP_AGENT_NAME;

/**
 * `client` tag on the ingest-log ledger for a bootstrap-import run. Distinct
 * from watcher ingest so a re-import is idempotent (same source hash -> no-op)
 * without colliding with the watcher's transcript-chunk rows.
 */
export const IMPORT_CLIENT = 'zm-import';

/**
 * `source.kind` stamped on a bootstrap-imported memory's provenance jsonb, so
 * imports stay filterable/auditable independently of author_kind/agent_name.
 * Imports are written as authoritative agent writes (agent_name null -> rank 1),
 * so a later watcher paraphrase of the same fact defers to the curated import.
 */
export const IMPORT_SOURCE_KIND = 'import';

/**
 * Rank of a provisional (watcher) memory — the lowest authority tier. Exposed so
 * consumers can test "both sides provisional" without hardcoding 0.
 */
export const PROVISIONAL_RANK = 0;

/**
 * Authority rank of a memory by ROLE — deliberately NOT by model tier, which
 * changes over time. Higher wins:
 *
 *   human (2) > in-band agent (1) > watcher / provisional (0)
 *
 * Hygiene uses this to auto-resolve an authoritative-vs-provisional conflict in
 * favour of the higher rank (without queuing a human); recall uses it to break
 * ties toward authoritative memories.
 */
export function provenanceRank(
  authorKind: MemoryAuthorKind,
  agentName: string | null
): number {
  if (authorKind === 'human') {
    return 2;
  }
  if (isProvisionalAgentName(agentName)) {
    return PROVISIONAL_RANK;
  }
  return 1;
}

/**
 * Key of the MCP transport session id (`ses_`) inside a memory's provenance
 * `source` jsonb. Server-stamped at write time; never taken from client input.
 */
export const SESSION_SOURCE_KEY = 'session';

/** The `ses_` session id carried in a memory's provenance source, if any. */
export const memorySessionId = (
  source: Record<string, unknown> | null | undefined
): string | null => {
  const value = source?.[SESSION_SOURCE_KEY];
  return typeof value === 'string' && value.startsWith(`${SESSION_ID_PREFIX}_`)
    ? value
    : null;
};

/**
 * Key of the SESSION MARKER inside a memory's provenance `source` jsonb: the
 * `thr_` token of the conversation this memory was born in. Server-stamped at
 * write time, never taken from client input.
 *
 * The marker is a POINTER, never content: it addresses the conversation, and
 * no fragment of that conversation's transcript is ever stored beside it. It
 * is what lets a fact be traced back to where it came from — the local
 * transcript can be re-mined on demand instead of being centralised.
 *
 * The thread is primary (over the raw client session id below) because it is
 * client-neutral and already survives a transport reconnect: one client
 * session may split across reconnects, and different clients number their
 * sessions differently, while a thread is our own abstraction.
 *
 * Its ABSENCE is an honest state, not a gap: quick-capture from a terminal,
 * import, bootstrap and dashboard writes have no conversation to point at.
 */
export const THREAD_SOURCE_KEY = 'thread';

/**
 * Key of the raw client session id inside a memory's provenance `source`
 * jsonb — an opaque string (for Claude Code, the transcript file's UUID). It
 * is the secondary half of the session marker: the thread addresses the
 * conversation for us, this addresses it in the client's own terms, which is
 * what a local re-mining pass needs to find the file.
 *
 * The PATH to that file is deliberately not stored: it is machine-specific
 * and reconstructible from `source.client` plus this id.
 */
export const CLIENT_SESSION_SOURCE_KEY = 'client_session_id';

/** The `thr_` session-thread token carried in a memory's provenance, if any. */
export const memoryThreadToken = (
  source: Record<string, unknown> | null | undefined
): string | null => {
  const value = source?.[THREAD_SOURCE_KEY];
  return typeof value === 'string' &&
    value.startsWith(`${ENTITY_PREFIXES.session_thread}_`)
    ? value
    : null;
};

/**
 * The opaque client session id carried in a memory's provenance, if any.
 * Opaque by contract — every client numbers its sessions its own way — so
 * the only check is that it is a non-empty string.
 */
export const memoryClientSessionId = (
  source: Record<string, unknown> | null | undefined
): string | null => {
  const value = source?.[CLIENT_SESSION_SOURCE_KEY];
  return typeof value === 'string' && value.length > 0 ? value : null;
};

/**
 * Cosine floor of the deterministic same-session refinement collapse: 0.95,
 * deliberately ABOVE the same-scope dedup threshold (0.92) and far above the
 * supersede-candidate aperture. Session identity alone does not make a
 * near-duplicate a restatement: one session routinely writes several
 * related-but-distinct facts about one topic with shared phrasing, and such
 * pairs reach 0.92+ (measured directly: two distinct same-session episode
 * fixtures at cosine 0.926 — collapsing them destroyed knowledge). The
 * refinement bursts this rule exists for sit at 0.97–0.99 (hygiene audit
 * measurement), so 0.95 covers them with margin on both sides; pairs below
 * it stay supersede hints / judge work.
 */
export const SAME_SESSION_COLLAPSE_MIN_SIMILARITY = 0.95;

/**
 * True when a near-duplicate pair is a same-session refinement BY
 * CONSTRUCTION: both sides authoritative (rank above provisional), both
 * stamped with the SAME MCP session id, cosine at or above the dedup-band
 * floor. Same writer + same conversation + same ground truth means the newer
 * side restates the older one, so the pair auto-supersedes toward the newest
 * — semantically identical to a declared supersede, with the intent inferred
 * from session identity instead of an explicit link. No LLM judge is
 * involved; the effect stays reversible. Deliberately NEVER extended to
 * cross-session pairs (those keep the judge).
 */
export function sameSessionRefinementPair(
  a: { source: Record<string, unknown> | null; rank: number },
  b: { source: Record<string, unknown> | null; rank: number },
  similarity: number
): boolean {
  if (similarity < SAME_SESSION_COLLAPSE_MIN_SIMILARITY) {
    return false;
  }
  if (a.rank <= PROVISIONAL_RANK || b.rank <= PROVISIONAL_RANK) {
    return false;
  }
  const sessionA = memorySessionId(a.source);
  return sessionA !== null && sessionA === memorySessionId(b.source);
}
