import {
  collectMemoryIds,
  isRecallTool,
  parseJsonLines,
  type ParsedTranscript,
  type TranscriptEntry,
} from '@workspace/client-core';
import { z } from 'zod';

/**
 * One coding-agent transcript line (JSONL). The schema is deliberately
 * loose: transcripts carry many line shapes (tool results, meta, summaries)
 * and the parser cares about human/assistant text plus the ids that recall /
 * build_context tool calls surfaced (the usefulness-judge input).
 */
const contentItemSchema = z.looseObject({
  type: z.string(),
  text: z.string().optional(),
  /** tool_use: the tool name and the call id it will be answered under. */
  name: z.string().optional(),
  id: z.string().optional(),
  /** tool_result: the id of the tool_use it answers. */
  tool_use_id: z.string().optional(),
  /** tool_result: set when the call did not run, e.g. a hook denied it. */
  is_error: z.boolean().optional(),
});

const transcriptLineSchema = z.looseObject({
  type: z.string().optional(),
  cwd: z.string().optional(),
  /** When the line was written (ISO 8601); dates a guard refusal. */
  timestamp: z.string().optional(),
  isMeta: z.boolean().optional(),
  /**
   * Marks the record a context compaction writes back into the transcript.
   * See the skip in {@link parseTranscript} for why it cannot be ingested.
   */
  isCompactSummary: z.boolean().optional(),
  message: z
    .looseObject({
      role: z.string().optional(),
      content: z.union([z.string(), z.array(contentItemSchema)]).optional(),
    })
    .optional(),
});

/**
 * Extracts from a slice of transcript JSONL: user and assistant TEXT (tool
 * calls, tool results, meta and system lines are skipped for the text), the
 * `cwd` the transcript recorded, and the `mem_` ids that recall / build_context
 * tool results surfaced. A recalled id is only taken from a tool_result whose
 * tool_use_id belongs to a recall / build_context call — so a `remember` result
 * (which returns a freshly-created id) is never mistaken for a recall hit.
 * Guard refusals are read off denied calls only (an error tool_result whose
 * hook reason opens with the `[guard:<name>]` tag): only the name and the
 * line's timestamp are kept.
 */
export const parseTranscript = (jsonl: string): ParsedTranscript => {
  const entries: TranscriptEntry[] = [];
  let cwd: string | undefined;
  const guardRefusals: ParsedTranscript['guardRefusals'] = [];
  // tool_use ids of recall / build_context calls, so their results (which
  // arrive on a later line) can be matched precisely.
  const recallCallIds = new Set<string>();
  const recalledIds = new Set<string>();

  for (const line of parseJsonLines(jsonl, transcriptLineSchema)) {
    const { type, isMeta, isCompactSummary, message } = line;
    cwd ??= line.cwd;

    // A context compaction appends its summary as a record that looks exactly
    // like something the human typed: `type: "user"`, `message.role: "user"`,
    // content a plain multi-kilobyte string, no `isMeta`. Ingesting it does two
    // distinct harms, and the second is the worse one. It re-states a session
    // whose facts were already captured, so extraction pays a second pass over
    // the same ground and duplicates invite themselves. And it MISATTRIBUTES:
    // an assistant-written recap says things like "the owner decided X", which
    // arrives labelled as the owner saying it — straight into the preference
    // and decision extraction, the paths most sensitive to who spoke. The flag
    // is the only thing distinguishing the record, so the skip is here rather
    // than in a caller that would have to re-derive it.
    if (isCompactSummary === true) {
      continue;
    }

    // Before the role and meta filters, which do not concern it: a refusal
    // arrives as the tool_result answering the denied call.
    collectGuardRefusals(message?.content, line.timestamp, guardRefusals);

    if (isMeta === true || (type !== 'user' && type !== 'assistant')) {
      continue;
    }
    const role = type;
    const content = message?.content;
    if (content === undefined) {
      continue;
    }

    let text: string;
    if (typeof content === 'string') {
      text = content;
    } else {
      // Array form: keep text items, drop tool_use / tool_result / thinking.
      text = content
        .filter((item) => item.type === 'text' && item.text)
        .map((item) => item.text!)
        .join('\n');
      collectRecalledIds(content, recallCallIds, recalledIds);
    }
    const normalized = text.trim();
    if (normalized.length === 0) {
      continue;
    }
    entries.push({ role, text: normalized });
  }

  return { entries, cwd, recalledIds: [...recalledIds], guardRefusals };
};

type ContentItem = z.infer<typeof contentItemSchema>;

/**
 * A denied call as Claude Code records it: an error tool_result reading
 * `PreToolUse:<Tool> hook error: <reason>`, where a guard opens its reason with
 * its tag, e.g. `[guard:commit_message_guard] …`. Anchored to the start of the
 * reason, so a guard named later in it is not the one refusing. The name
 * pattern is the contract's guard name, so whatever this matches the server
 * accepts.
 */
const GUARD_REFUSAL = /hook error:\s*\[guard:([a-z][a-z0-9_-]{1,63})\]/u;

/**
 * Appends the guard refusals one line records, oldest first: at most one per
 * denied call. Only an error tool_result counts. A call that succeeded can
 * still print the tag (a read of a guard script, grep or test output, a recall
 * quoting a stored refusal), and the tag in prose, in the call's own input or
 * in a compaction recap is talk about a guard, not a refusal by one.
 */
const collectGuardRefusals = (
  content: string | ContentItem[] | undefined,
  timestamp: string | undefined,
  guardRefusals: ParsedTranscript['guardRefusals']
): void => {
  if (!Array.isArray(content)) {
    return;
  }
  for (const item of content) {
    if (item.type !== 'tool_result' || item.is_error !== true) {
      continue;
    }
    const reason = typeof item.content === 'string' ? item.content : '';
    const guard = GUARD_REFUSAL.exec(reason)?.[1];
    if (guard) {
      guardRefusals.push({ guard, at: timestamp ?? null });
    }
  }
};

/**
 * Registers recall / build_context tool_use ids and, for a tool_result that
 * answers one of them, pulls the surfaced `mem_` ids out of its payload.
 * tool_use always precedes its tool_result in the JSONL, so a single forward
 * pass over the accumulated call ids is enough within a slice.
 */
const collectRecalledIds = (
  content: ContentItem[],
  recallCallIds: Set<string>,
  recalledIds: Set<string>
): void => {
  for (const item of content) {
    if (item.type === 'tool_use' && item.id && isRecallTool(item.name)) {
      recallCallIds.add(item.id);
      continue;
    }
    if (item.type === 'tool_result' && item.tool_use_id) {
      if (!recallCallIds.has(item.tool_use_id)) {
        continue;
      }
      // Stringify the whole item so nested result shapes (string, array of
      // text blocks) are all covered; the tool_use_id itself is a `toolu_` id,
      // never a `mem_` id, so it cannot pollute the match.
      for (const id of collectMemoryIds(JSON.stringify(item))) {
        recalledIds.add(id);
      }
    }
  }
};
