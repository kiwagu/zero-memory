import {
  collectMemoryIds,
  isRecallTool,
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
});

const transcriptLineSchema = z.looseObject({
  type: z.string().optional(),
  cwd: z.string().optional(),
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
 */
export const parseTranscript = (jsonl: string): ParsedTranscript => {
  const entries: TranscriptEntry[] = [];
  let cwd: string | undefined;
  // tool_use ids of recall / build_context calls, so their results (which
  // arrive on a later line) can be matched precisely.
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
    const line = transcriptLineSchema.safeParse(parsed);
    if (!line.success) {
      continue;
    }
    const { type, isMeta, isCompactSummary, message } = line.data;
    cwd ??= line.data.cwd;

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

  return { entries, cwd, recalledIds: [...recalledIds] };
};

type ContentItem = z.infer<typeof contentItemSchema>;

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
