import {
  collectMemoryIds,
  isRecallTool,
  type ParsedTranscript,
  type TranscriptEntry,
} from '@workspace/client-core';
import { z } from 'zod';

/**
 * Hermes has NO on-disk session transcript to tail, and that absence is the
 * one structural difference between this adapter and its three siblings.
 * Claude Code, Codex and Cursor each write a JSONL file per session, so their
 * adapters parse a format the client already produces. Hermes keeps its
 * sessions in SQLite (`<HERMES_HOME>/<profile>/state.db`, tables `sessions` /
 * `messages`) — a live, concurrently-written database with no append-only byte
 * stream, which is exactly what the shared ingest path needs: it ships the
 * delta since a stored byte OFFSET.
 *
 * Reading that database directly was rejected on two counts. It is a private
 * schema of another product (it may change on any Hermes upgrade, and nothing
 * would tell us), and an offset into a table is not a thing that exists —
 * re-deriving "what is new" would mean re-reading and diffing the whole
 * conversation on every turn.
 *
 * So the Hermes PLUGIN mirrors each completed turn into an append-only JSONL
 * file of its own, and this parser reads that mirror. The format below is
 * therefore a CONTRACT BETWEEN TWO HALVES OF THIS REPOSITORY (the plugin at
 * `plugins/zero-memory-hermes/` writes it, this file reads it) rather than a
 * foreign format we must accept as found — which is why it is the smallest
 * shape that answers the ingest domain's questions, and nothing more:
 *
 *  - `{"type":"session","cwd":"…","session_id":"…"}` — one header line per
 *    file, written when the mirror is opened. Carries the project root, so
 *    ingest scopes the capture the way Codex's `session_meta` line does.
 *  - `{"type":"message","role":"user"|"assistant","text":"…"}` — the
 *    conversational stream, one line per completed turn half.
 *  - `{"type":"tool_result","tool":"…","result":"…"}` — written ONLY for
 *    recall / build_context calls. This is the judge channel: without it the
 *    "shown" set is empty and recall usefulness silently measures nothing
 *    (the same gap Cursor has structurally, which here would be self-inflicted).
 *
 * Unknown line types are skipped rather than rejected, so a newer plugin
 * writing a richer mirror stays readable by an older watcher.
 */
const hermesLineSchema = z.looseObject({
  type: z.string().optional(),
  role: z.string().optional(),
  text: z.string().optional(),
  cwd: z.string().optional(),
  /** tool_result: the tool's name, as Hermes records it. */
  tool: z.string().optional(),
  /** tool_result: the tool's response — shape varies, mined as text. */
  result: z.unknown().optional(),
});

/** Mirror roles that are conversational (anything else is not ingested). */
const CONVERSATIONAL_ROLES = new Set(['user', 'assistant']);

/**
 * Parses a slice of the Hermes mirror JSONL into the client-agnostic
 * {@link ParsedTranscript}: the user/assistant text, the `cwd` from the header
 * line, and the `mem_` ids a recall / build_context result surfaced.
 *
 * A slice may begin mid-file (ingest sends the delta since the last offset),
 * so the header is optional here: `cwd` is simply absent when the slice does
 * not contain it, and the runner falls back to the hook payload's own cwd.
 */
export const parseHermesTranscript = (jsonl: string): ParsedTranscript => {
  const entries: TranscriptEntry[] = [];
  let cwd: string | undefined;
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
      continue; // torn line at a slice boundary, or a partial write
    }
    const line = hermesLineSchema.safeParse(parsed);
    if (!line.success) {
      continue;
    }
    const { type, role, text, tool, result } = line.data;

    if (type === 'session') {
      cwd ??= line.data.cwd;
      continue;
    }
    if (type === 'tool_result') {
      if (isRecallTool(tool)) {
        // Stringified so every result shape (plain string, content blocks,
        // nested object) is covered by one pass, exactly as the Codex adapter
        // does. `JSON.stringify(undefined)` is not a string — fall back to ''.
        for (const id of collectMemoryIds(JSON.stringify(result) ?? '')) {
          recalledIds.add(id);
        }
      }
      continue;
    }
    if (type !== 'message' || role === undefined) {
      continue;
    }
    if (!CONVERSATIONAL_ROLES.has(role)) {
      continue; // system / tool bookkeeping is not conversation
    }
    const body = (text ?? '').trim();
    if (body.length === 0) {
      continue;
    }
    entries.push({ role: role as TranscriptEntry['role'], text: body });
  }

  return { entries, cwd, recalledIds: [...recalledIds] };
};
