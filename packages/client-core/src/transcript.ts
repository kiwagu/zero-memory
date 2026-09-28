/**
 * The transcript-source PORT's output contract — client-agnostic. A coding
 * agent's session transcript (Claude Code JSONL, Cursor JSONL, …) is parsed by
 * a per-client adapter into this one shape, which the ingest domain consumes
 * without knowing which client produced it. The parsers themselves live in the
 * `@workspace/client-adapter-*` packages; only the shape and the renderer are
 * domain.
 */

export interface TranscriptEntry {
  role: 'user' | 'assistant';
  text: string;
}

export interface ParsedTranscript {
  entries: TranscriptEntry[];
  /** Working directory the transcript recorded, when the format carries it
   * (Claude lines do; Cursor's do not — the runner supplies it from the hook
   * payload's workspace root instead). */
  cwd?: string;
  /** `mem_` ids a recall / build_context call surfaced to the agent in this
   * slice — the "shown" set the usefulness judge scores against the text. Empty
   * when the client's transcript does not inline tool results (e.g. Cursor). */
  recalledIds: string[];
}

/**
 * What {@link parseJsonLines} checks each record against — a zod schema, taken
 * structurally so this package needs no validator of its own.
 */
export interface JsonLineSchema<T> {
  safeParse(value: unknown): { success: true; data: T } | { success: false };
}

/**
 * The records of a JSONL slice that parse and match `schema`, in order. Every
 * client's transcript is read a slice at a time from a byte offset, so the
 * first line can be torn, the last one half-written, and any line may belong
 * to a shape the parser does not read: all of those are skipped rather than
 * failing the slice, as are blank lines.
 */
export const parseJsonLines = <T>(
  jsonl: string,
  schema: JsonLineSchema<T>
): T[] => {
  const records: T[] = [];
  for (const rawLine of jsonl.split('\n')) {
    const trimmed = rawLine.trim();
    if (trimmed.length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue; // torn or non-JSON line
    }
    const line = schema.safeParse(parsed);
    if (line.success) records.push(line.data);
  }
  return records;
};

/** Renders entries in the `role: text` form the extractor consumes. */
export const formatEntries = (entries: TranscriptEntry[]): string =>
  entries.map((entry) => `${entry.role}: ${entry.text}`).join('\n');
