import {
  RESULT_ATTRIBUTED_TOOLS,
  type RememberResultMetering,
  type ToolErrorMetering,
  type ToolResultMetering,
} from '@workspace/mcp';
import { recordUsage, type IUsageRecorder } from '@workspace/usage';

/**
 * Value-metering emit helpers shared by both MCP transports (HTTP + stdio).
 *
 * Every tool call emits exactly one `mcp_tool_call` volume row. For most tools
 * that is the pre-execution seam ({@link recordToolInvocation}). Read tools in
 * RESULT_ATTRIBUTED_TOOLS instead emit it result-aware
 * ({@link recordToolResult}), carrying the surfaced `mem_` ids — so the
 * pre-execution seam skips them to avoid a double count. These helpers also own
 * the session-briefing signal. Every emit is fire-and-forget (via
 * recordUsage): metering must never break or slow the operation it measures.
 * Content-free by construction: only counts and ids flow here.
 */

const isResultAttributed = (tool: string): boolean =>
  (RESULT_ATTRIBUTED_TOOLS as readonly string[]).includes(tool);

/**
 * Pre-execution volume emit for a tool call. No-op for result-attributed read
 * tools (recall / build_context) — their row is emitted post-result by
 * {@link recordToolResult} so it can carry the surfaced ids.
 */
export const recordToolInvocation = (
  recorder: IUsageRecorder,
  tool: string
): void => {
  if (isResultAttributed(tool)) {
    return;
  }
  recordUsage(recorder, { eventType: 'mcp_tool_call', metadata: { tool } });
};

/**
 * Post-result emit for a read tool: its single `mcp_tool_call` volume row,
 * enriched with the surfaced `mem_` ids (surfaced-count fuel for "top facts"),
 * plus a `session_briefing` when the call was the session-start briefing.
 */
/**
 * Cap on the stored search string. The query is a deliberate, owner-approved
 * exception to the content-free metering posture (it is the user's own search
 * input; the activity feed cannot explain an empty recall without it) — but
 * it stays bounded.
 */
const QUERY_MAX_LENGTH = 200;

const truncatedQuery = (query: string | null): string | undefined =>
  query ? query.slice(0, QUERY_MAX_LENGTH) : undefined;

export const recordToolResult = (
  recorder: IUsageRecorder,
  metering: ToolResultMetering
): void => {
  recordUsage(recorder, {
    eventType: 'mcp_tool_call',
    agentName: metering.agentName,
    metadata: {
      tool: metering.tool,
      returned: metering.returnedIds.length,
      returned_ids: metering.returnedIds,
      // Scope observability (the scope-usage audit trail): how the search
      // set was decided, the session's project at call time, and where the
      // returned hits came from — recorded at the source so the audit is a
      // GROUP BY instead of a fragile reconstruction.
      read_mode: metering.scopes.mode,
      ...(metering.scopes.sessionScope !== null && {
        session_scope: metering.scopes.sessionScope,
      }),
      returned_by_scope: metering.scopes.returnedByScope,
      ...(truncatedQuery(metering.query) !== undefined && {
        query: truncatedQuery(metering.query),
      }),
    },
  });
  recordBriefing(recorder, metering);
};

/**
 * Error emit for a FAILED read tool: its volume row is normally emitted
 * post-result, so a failure would otherwise leave no row. One `mcp_tool_call`
 * flagged `error: true` — no `returned`/`returned_ids`, so error rows never
 * enter the hit/empty (surfaced-count) aggregates.
 */
export const recordToolError = (
  recorder: IUsageRecorder,
  metering: ToolErrorMetering
): void => {
  recordUsage(recorder, {
    eventType: 'mcp_tool_call',
    agentName: metering.agentName,
    metadata: {
      tool: metering.tool,
      error: true,
      ...(truncatedQuery(metering.query) !== undefined && {
        query: truncatedQuery(metering.query),
      }),
    },
  });
};

/**
 * Post-result volume emit for `remember`: its single `mcp_tool_call` row,
 * carrying the supersede-candidate ids surfaced in the response as
 * `similar_ids`. The receipt's rediscovery metric later joins these against the
 * session's recalls and the write window to count prior memories the agent
 * rewrote without recalling. `similar_ids` is omitted when none were surfaced,
 * so an ordinary write stays a bare `{tool}` row.
 */
export const recordRememberResult = (
  recorder: IUsageRecorder,
  metering: RememberResultMetering
): void => {
  recordUsage(recorder, {
    eventType: 'mcp_tool_call',
    agentName: metering.agentName,
    metadata: {
      tool: 'remember',
      ...(metering.similarIds.length > 0 && {
        similar_ids: metering.similarIds,
      }),
    },
  });
};

/**
 * In-band recall-usefulness emit: one `recall_used` row per memory id
 * the caller referenced via a supersedes/derived_from link on a `remember` —
 * proof it used that recalled fact. `source: in_band` is the high-precision
 * channel (the watcher judge later fills coverage as `source: judge`);
 * `useful: true` because an in-band reference is affirmative by construction.
 * Content-free (ids/flags only). Fire-and-forget: never break `remember`.
 */
export const recordInBandRecallUsed = (
  recorder: IUsageRecorder,
  usedIds: string[]
): void => {
  for (const memId of usedIds) {
    recordUsage(recorder, {
      eventType: 'recall_used',
      metadata: { mem_id: memId, source: 'in_band', useful: true },
    });
  }
};

/**
 * Misled-valence emit: one `recall_used` row when the caller explicitly
 * challenged a memory as wrong/stale — the negative counterpart of the
 * in-band channel, and equally deterministic (an affirmative agent act, not
 * an inference). Feeds the reinforcement demotion and the stale-suspect
 * rollup; everything that filters on `useful: true` ignores it. Content-free.
 * Fire-and-forget: never break `challenge`.
 */
export const recordChallengeMisled = (
  recorder: IUsageRecorder,
  memId: string
): void => {
  recordUsage(recorder, {
    eventType: 'recall_used',
    metadata: {
      mem_id: memId,
      source: 'challenge',
      useful: false,
      valence: 'misled',
    },
  });
};

// A briefing memory row costs ~200 tokens, an entity far less — mirrors the
// build_context row-budget heuristic in the memory service. The token estimate
// is the "saved tokens" fuel: what the user would have re-typed as context.
const BRIEFING_TOKENS_PER_MEMORY = 200;
const BRIEFING_TOKENS_PER_ENTITY = 40;

/**
 * Emit `session_briefing` for a briefing `build_context`. No-op
 * unless the call carried the briefing flag. `quantity` is the estimated
 * briefing size in tokens; `metadata.empty` is the briefing hit-rate signal;
 * `metadata.briefing_kind` splits session-start vs task briefings so
 * hit-rate is measurable per kind.
 */
export const recordBriefing = (
  recorder: IUsageRecorder,
  metering: ToolResultMetering
): void => {
  const { briefing } = metering;
  if (!briefing) {
    return;
  }
  const tokens =
    briefing.memories * BRIEFING_TOKENS_PER_MEMORY +
    briefing.entities * BRIEFING_TOKENS_PER_ENTITY;
  recordUsage(recorder, {
    eventType: 'session_briefing',
    unit: 'tokens',
    quantity: tokens,
    agentName: metering.agentName,
    metadata: {
      topic_len: briefing.topicLen,
      returned: metering.returnedIds.length,
      empty: metering.returnedIds.length === 0,
      briefing_kind: briefing.kind,
      // Present for hook-delivered briefings: joins this broadcast to the
      // same conversation's ingest/judge rows across the connection boundary.
      ...(briefing.conversationId !== null && {
        conversation_id: briefing.conversationId,
      }),
    },
  });
};
