/**
 * Display form of a memory's provenance `source`.
 *
 * The panel exists to answer "where did this come from" — which tool, which
 * conversation, which file, which hash. A path answers that with its FILE NAME;
 * the directories above it only describe the machine that happened to ingest
 * it, and that is exactly what should not be on a shared screen, in a
 * screenshot, or in a support thread. So the tree is folded away and the full
 * value stays one hover behind `title` — nothing is dropped, and the audit
 * story is unchanged.
 */

/** Keys whose values are filesystem paths rather than opaque identifiers. */
const PATH_KEYS = new Set(['path', 'source_path', 'file']);

/**
 * The session marker's key and token prefix, restated here rather than
 * imported: web cannot import @workspace/contracts (its NodeNext `.js`
 * internals do not resolve under Turbopack), the same constraint the feed's
 * id-prefix pattern lives under. Both are part of the stored provenance
 * shape, so they change only when that shape does.
 */
const THREAD_KEY = 'thread';
const THREAD_PREFIX = 'thr_';

/**
 * The `thr_` token of the conversation a memory was born in, or null when it
 * was written outside any — an import, the repository bootstrap, a terminal
 * capture, a dashboard action, or anything written before the marker existed.
 * That absence is an honest state, so it reads as "no session", never as a
 * missing lookup.
 */
export function memoryThreadToken(
  source: Record<string, unknown> | null | undefined
): string | null {
  const value = source?.[THREAD_KEY];
  return typeof value === 'string' && value.startsWith(THREAD_PREFIX)
    ? value
    : null;
}

/** The last segment of a POSIX or Windows path, or the value when it has none. */
export function pathBasename(value: string): string {
  const segments = value.split(/[/\\]/).filter(Boolean);
  return segments.at(-1) ?? value;
}

/** One provenance row as the panel renders it. */
export interface ProvenanceEntry {
  key: string;
  /** What is printed. */
  display: string;
  /** The untruncated value, when it differs from what is printed. */
  full?: string;
}

/**
 * Flattens `source` into printable rows, shortening path-valued fields.
 * Non-string values are JSON-encoded so nested objects still show.
 */
export function provenanceEntries(
  source: Record<string, unknown>
): ProvenanceEntry[] {
  return Object.entries(source).map(([key, value]) => {
    if (typeof value !== 'string') {
      return { key, display: JSON.stringify(value) };
    }
    if (!PATH_KEYS.has(key)) {
      return { key, display: value };
    }
    const short = pathBasename(value);
    return short === value
      ? { key, display: value }
      : { key, display: short, full: value };
  });
}
