import {
  type ParsedTranscript,
  type TranscriptEntry,
} from '@workspace/client-core';
import { z } from 'zod';

/**
 * Cursor's on-disk agent transcript is JSONL, one object per line, at
 * `~/.cursor/projects/<slug>/agent-transcripts/<session_id>/<session_id>.jsonl`
 * — the same path a `stop` hook hands over as `transcript_path`. Its envelope
 * differs from Claude Code's (verified against a real session, 2026-07-17):
 *
 *  - `role` is a TOP-LEVEL field (sibling of `message`), not `message.role`.
 *  - a user line wraps its text as
 *    `<timestamp>…</timestamp>\n<user_query>\n…\n</user_query>` — we keep only
 *    the query.
 *  - assistant reasoning is privacy-stripped to the literal token `[REDACTED]`,
 *    which we drop (a line that is only reasoning becomes empty and is skipped).
 *  - control lines like `{"type":"turn_ended","status":"success"}` carry no
 *    role and are skipped.
 *
 * RECALLED IDS ARE NOT AVAILABLE HERE, and the reason is structural rather
 * than a shortcut — re-verified against real transcripts on 2026-07-29, since
 * the Codex adapter gained id mining in the same change:
 *
 *  - an MCP call is not recorded under its own name at all: Cursor routes every
 *    one through `tool_use` `name: "CallDynamicTool"`, with the real tool in
 *    `input.toolName` (bare, e.g. `recall`) and the mount in `input.namespace`
 *    (e.g. `user-zero-memory`). Recognizing the call is therefore easy — the
 *    shared `isRecallTool` handles that bare form.
 *  - what is missing is the RESULT. Tool results are not inlined (no
 *    `tool_result` blocks anywhere), and a `tool_use` block carries NO id — its
 *    only keys are `type`, `name`, `input`. Cursor spills large tool/MCP output
 *    to sibling `agent-tools/<uuid>.txt` files, and nothing in the transcript
 *    links a call to its spill file; the path appears only when the agent
 *    happens to Read it, which is an agent action, not a record.
 *
 * So there is no key on which a recall could be correlated to the ids it
 * surfaced. Scanning the spill directory wholesale would also sweep up
 * `remember` and `export_memories` output — ids the agent was never SHOWN —
 * inflating the judge's input rather than measuring it. An empty
 * `recalledIds` reports the gap honestly instead of faking coverage.
 */
const cursorBlockSchema = z.looseObject({
  type: z.string(),
  text: z.string().optional(),
});

const cursorLineSchema = z.looseObject({
  role: z.string().optional(),
  message: z
    .looseObject({
      content: z.union([z.string(), z.array(cursorBlockSchema)]).optional(),
    })
    .optional(),
});

const REDACTED = '[REDACTED]';
const USER_QUERY_RE = /<user_query>\s*([\s\S]*?)\s*<\/user_query>/;
const TIMESTAMP_RE = /<timestamp>[\s\S]*?<\/timestamp>/g;

/** Keeps only the `<user_query>` body; falls back to the text minus any
 * `<timestamp>` wrapper when the tag is absent (older/edge formats). */
const unwrapUserQuery = (text: string): string => {
  const match = USER_QUERY_RE.exec(text);
  if (match?.[1] !== undefined) {
    return match[1];
  }
  return text.replace(TIMESTAMP_RE, '');
};

/** Drops the reasoning-stripped `[REDACTED]` markers, keeping real text. */
const stripRedacted = (text: string): string => text.split(REDACTED).join('');

/**
 * Parses a slice of Cursor transcript JSONL into the client-agnostic
 * {@link ParsedTranscript}: user and assistant TEXT only (tool_use calls,
 * control lines, and `[REDACTED]` reasoning dropped). `cwd` is left undefined
 * (Cursor lines carry no working dir — the hook runner supplies the project
 * from the payload's workspace root) and `recalledIds` is always empty, for the
 * structural reason documented above.
 */
export const parseCursorTranscript = (jsonl: string): ParsedTranscript => {
  const entries: TranscriptEntry[] = [];

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
    const line = cursorLineSchema.safeParse(parsed);
    if (!line.success) {
      continue;
    }
    const role = line.data.role;
    // Skips control lines (turn_ended, …) and anything not a chat turn.
    if (role !== 'user' && role !== 'assistant') {
      continue;
    }
    const content = line.data.message?.content;
    if (content === undefined) {
      continue;
    }

    let text: string;
    if (typeof content === 'string') {
      text = content;
    } else {
      text = content
        .filter((item) => item.type === 'text' && item.text)
        .map((item) => item.text!)
        .join('\n');
    }
    text = role === 'user' ? unwrapUserQuery(text) : stripRedacted(text);
    const normalized = text.trim();
    if (normalized.length === 0) {
      continue;
    }
    entries.push({ role, text: normalized });
  }

  return { entries, recalledIds: [] };
};
