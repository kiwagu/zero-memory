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

/** Renders entries in the `role: text` form the extractor consumes. */
export const formatEntries = (entries: TranscriptEntry[]): string =>
  entries.map((entry) => `${entry.role}: ${entry.text}`).join('\n');
