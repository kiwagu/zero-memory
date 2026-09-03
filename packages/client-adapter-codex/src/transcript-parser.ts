import {
  collectMemoryIds,
  isRecallTool,
  type ParsedTranscript,
  type TranscriptEntry,
} from '@workspace/client-core';
import { z } from 'zod';

/**
 * Codex's on-disk transcript is a JSONL "rollout" file at
 * `~/.codex/sessions/YYYY/MM/DD/rollout-<ISO-ts>-<uuid>.jsonl` — the file a
 * Codex machine tails (or a Stop hook hands over) for ingest. Each line is
 * `{ type, payload, timestamp }` (verified against a real session):
 *
 *  - `type: "session_meta"` — the header; `payload.cwd` is the project root
 *    (Codex records it, unlike Cursor), so ingest gets the right scope.
 *  - `type: "event_msg"` — the clean conversational stream: `payload.type`
 *    `"user_message"` / `"agent_message"` carry `payload.message` (the plain
 *    text). This is what we ingest.
 *  - `type: "response_item"` — the raw model-API items (role `developer` system
 *    prompts, `reasoning`, tool calls) — heavy noise (permissions blocks,
 *    multi-agent instructions), so we DELIBERATELY skip them for the TEXT and
 *    read only the `event_msg` stream. Their tool items ARE mined for recalled
 *    ids, though (see below).
 *  - other types (`turn_context`, `world_state`, token counts, task markers)
 *    are skipped.
 *
 * RECALLED IDS (verified against real rollouts, 2026-07-29). An MCP tool call
 * is a `response_item` whose `payload.type` is `"function_call"`, and — unlike
 * Claude Code — Codex records the tool's name BARE in `payload.name`, keeping
 * the mount in a `payload.namespace` field of its own (observed
 * `"mcp__zero_memory"`). The result arrives on a later
 * `payload.type: "function_call_output"` line carrying the same
 * `payload.call_id`, and `payload.output` holds the tool's response (a string,
 * or an array of text blocks). Correlating by `call_id` — rather than scanning
 * every output — is what keeps a `remember` result's freshly-created id from
 * being counted as a recall hit. The namespace is deliberately NOT matched on:
 * it differs per client and per install, and a foreign server's same-named tool
 * is harmless because ids are taken with the store's own id format.
 *
 * THE SECOND ENVELOPE (measured 2026-07-30 across every rollout on a dogfooding
 * machine). The same MCP call is ALSO recorded on the `event_msg` stream as
 * `payload.type: "mcp_tool_call_end"` — `payload.invocation.tool` is the bare
 * name, `payload.invocation.server` the mount, and `payload.result` holds the
 * answer (`{Ok: {content: [...]}}`, or `{Err: …}` when the call failed). Reading
 * only the first envelope loses whole sessions rather than stray calls: a
 * session was observed whose seven recall / build_context calls appear ONLY in
 * this form, hiding fifty-nine distinct ids from the judge — silently, since an
 * empty result is indistinguishable from a session that never consulted memory.
 * Which envelope a session lands in is not a version that has passed: sessions
 * recorded the same day carry both, or only this one. Here the invocation and
 * its answer share ONE line, so no `call_id` bookkeeping is needed — the tool
 * name sitting next to the result is what keeps a write's id out of the count.
 * Ids collapse into one set, so a call recorded in both envelopes counts once.
 */
const codexLineSchema = z.looseObject({
  type: z.string().optional(),
  payload: z
    .looseObject({
      type: z.string().optional(),
      message: z.string().optional(),
      cwd: z.string().optional(),
      /** function_call: the tool's bare name and the id its output will carry. */
      name: z.string().optional(),
      call_id: z.string().optional(),
      /** function_call_output: the tool's response, shape varies by tool. */
      output: z.unknown().optional(),
      /** mcp_tool_call_end: the tool that was called, on the answer's own line. */
      invocation: z
        .looseObject({
          server: z.string().optional(),
          tool: z.string().optional(),
        })
        .optional(),
      /** mcp_tool_call_end: the answer itself — `{Ok: …}` or `{Err: …}`. */
      result: z.unknown().optional(),
    })
    .optional(),
});

/** event_msg payload.type → transcript role (others are not conversational). */
const ROLE_BY_EVENT: Record<string, TranscriptEntry['role']> = {
  user_message: 'user',
  agent_message: 'assistant',
};

/**
 * Parses a slice of Codex rollout JSONL into the client-agnostic
 * {@link ParsedTranscript}: the `event_msg` user/assistant text, `cwd` from the
 * `session_meta` header when present, and the `mem_` ids that recall /
 * build_context results surfaced to the agent.
 */
export const parseCodexTranscript = (jsonl: string): ParsedTranscript => {
  const entries: TranscriptEntry[] = [];
  let cwd: string | undefined;
  // call_ids of recall / build_context calls, so their outputs (which arrive on
  // a later line) can be matched precisely.
  const recallCallIds = new Set<string>();
  const recalledIds = new Set<string>();

  for (const rawLine of jsonl.split('\n')) {
    const trimmed = rawLine.trim();
    if (trimmed.length === 0) {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue; // torn or non-JSON line
    }
    const line = codexLineSchema.safeParse(parsed);
    if (!line.success) {
      continue;
    }
    const { type, payload } = line.data;

    if (type === 'session_meta') {
      cwd ??= payload?.cwd;
      continue;
    }
    if (type === 'response_item' && payload !== undefined) {
      collectRecalledIds(payload, recallCallIds, recalledIds);
      continue;
    }
    if (type !== 'event_msg' || payload?.type === undefined) {
      continue;
    }
    if (payload.type === 'mcp_tool_call_end') {
      collectEventStreamRecalledIds(payload, recalledIds);
      continue;
    }
    const role = ROLE_BY_EVENT[payload.type];
    if (role === undefined) {
      continue; // task_started, token_count, web_search_end, …
    }
    const text = (payload.message ?? '').trim();
    if (text.length === 0) {
      continue;
    }
    entries.push({ role, text });
  }

  return { entries, cwd, recalledIds: [...recalledIds] };
};

type CodexPayload = NonNullable<z.infer<typeof codexLineSchema>['payload']>;

/**
 * Registers recall / build_context `call_id`s and, for the output that answers
 * one of them, pulls the surfaced `mem_` ids out of it. A call always precedes
 * its output in the rollout, so one forward pass over the accumulated ids is
 * enough within a slice.
 */
const collectRecalledIds = (
  payload: CodexPayload,
  recallCallIds: Set<string>,
  recalledIds: Set<string>
): void => {
  if (payload.call_id === undefined) {
    return;
  }
  if (payload.type === 'function_call') {
    if (isRecallTool(payload.name)) {
      recallCallIds.add(payload.call_id);
    }
    return;
  }
  if (
    payload.type !== 'function_call_output' ||
    !recallCallIds.has(payload.call_id)
  ) {
    return;
  }
  // Stringify the output so every observed shape (plain string, array of text
  // blocks) is covered by one pass. `JSON.stringify(undefined)` is not a
  // string, so an output-less line falls back to an empty payload.
  for (const id of collectMemoryIds(JSON.stringify(payload.output) ?? '')) {
    recalledIds.add(id);
  }
};

/**
 * Pulls the ids out of the event-stream envelope, where the invocation and its
 * answer arrive together. The tool name is read from `invocation.tool` and never
 * from `invocation.server`: the server string is a per-install mount name, while
 * the tool name is the same bare word every client records.
 *
 * The whole `result` is stringified rather than just its `Ok` branch — the same
 * shape-tolerance the other envelope gets, and a failed call carries no ids to
 * find anyway.
 */
const collectEventStreamRecalledIds = (
  payload: CodexPayload,
  recalledIds: Set<string>
): void => {
  if (!isRecallTool(payload.invocation?.tool)) {
    return;
  }
  for (const id of collectMemoryIds(JSON.stringify(payload.result) ?? '')) {
    recalledIds.add(id);
  }
};
