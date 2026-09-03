/**
 * Splitting a stored passage across the embedding model's input window.
 *
 * The model reads a fixed 512-token window and the tokenizer truncates to it
 * SILENTLY — no flag, no warning, no error. Everything past the window is
 * absent from the vector, so a fact stated late in a long memory cannot be
 * reached by semantic search at all; only an exact-wording full-text match
 * finds it.
 *
 * Measured on this corpus's English technical prose (~4.5 characters per
 * token) against the real stored vectors: appending 459 characters of
 * unrelated text to a 2400-character body left the vector bit-for-bit
 * identical, and a probe cut from a long memory's own tail found its parent in
 * the top result 10% of the time (top-10: 53%) against 88% / 100% for bodies
 * whose tail still fits inside the window.
 *
 * The fix is to cover the WHOLE passage with as many windows as it takes,
 * rather than a fixed number of them. A fixed count has no principled value —
 * any answer to "why two and not three" is arbitrary, and the record that
 * needs a third is exactly the one a fixed two would fail. Coverage is
 * therefore a function of length, and the only fixed quantity is the window
 * itself, which belongs to the model.
 *
 * The two vectors of one record never compete for separate result slots:
 * search collapses a record's windows by taking its closest one, so a long
 * memory occupies ONE row with a better distance. What full coverage does
 * cost is topical reach — a fully searchable record matches more queries than
 * one searchable by its opening — and that is the accepted price of the
 * knowledge in it being reachable at all.
 */

/**
 * Characters that certainly fit inside the window, whatever the prose density.
 *
 * Deliberately conservative: the cliff for ordinary prose sits near 2300
 * characters, but identifier- and number-dense text tokenizes worse, so every
 * window is sized to the density-independent floor. Being early costs a little
 * redundant overlap; being late loses content to the gap between windows.
 */
export const EMBEDDING_WINDOW_CHARS = 1800;

/**
 * Characters each window shares with the previous one.
 *
 * Without an overlap a sentence lying across a boundary is split between two
 * vectors and stated whole in neither, which is the same invisibility the
 * windows exist to remove — just moved to a different place.
 */
export const WINDOW_OVERLAP_CHARS = 200;

/**
 * Hard bound on the number of overflow windows one passage may produce.
 *
 * Memory content has no length limit in the contract, so without a bound a
 * pathological write would fan out into unbounded embedding work. At the
 * window size above this still covers roughly 40,000 characters — far past
 * anything a memory should be. Reaching it is reported by
 * {@link passageCoverageShortfall}, never silently swallowed.
 */
export const MAX_OVERFLOW_WINDOWS = 24;

/** One embedding window over a stored passage, with where it starts. */
export interface PassageWindow {
  /** The text handed to the model for this window. */
  text: string;
  /**
   * Character offset of this window in the content. 0 is the primary window.
   *
   * Stored alongside the vector rather than re-derived by readers: whoever
   * needs to show "the part that matched" must not have to reconstruct the
   * writer's geometry from a stride constant, which would silently rot the
   * moment the window size changed.
   */
  charStart: number;
}

/** Where each overflow window starts, in order. */
const overflowStarts = (length: number): number[] => {
  // A passage the primary vector certainly reaches whole needs no overflow at
  // all; without this guard a passage barely over the stride would produce a
  // window entirely inside what the primary already covers.
  if (length <= EMBEDDING_WINDOW_CHARS) {
    return [];
  }
  const stride = EMBEDDING_WINDOW_CHARS - WINDOW_OVERLAP_CHARS;
  const starts: number[] = [];
  for (
    let start = stride;
    start < length && starts.length < MAX_OVERFLOW_WINDOWS;
    start += stride
  ) {
    starts.push(start);
  }
  return starts;
};

/**
 * The windows to embed for one stored passage, in storage order.
 *
 * The FIRST element is the whole content at offset 0 — the passage's primary
 * window, which the model truncates to its input window exactly as before.
 * Keeping it unchanged is what lets stored primary vectors keep their meaning
 * without a re-embed, and it stays the record's identity for write-time dedup
 * and supersede probes.
 *
 * The rest are the OVERFLOW windows: successive slices covering everything the
 * primary window could not reach, each overlapping the previous one. A passage
 * that fits whole yields a single element.
 */
export const passageWindows = (content: string): PassageWindow[] => [
  { text: content, charStart: 0 },
  ...overflowStarts(content.length).map((start) => ({
    text: content.slice(start, start + EMBEDDING_WINDOW_CHARS),
    charStart: start,
  })),
];

/** How many overflow windows a passage needs beyond its primary one. */
export const overflowWindowCount = (content: string): number =>
  overflowStarts(content.length).length;

/**
 * Characters at the end of a passage that no window reaches because
 * {@link MAX_OVERFLOW_WINDOWS} was hit — 0 for every passage of a sane size.
 *
 * Exists so a caller can SAY that coverage fell short instead of a pathological
 * record quietly losing its ending, which is the very failure this module was
 * written to remove.
 */
export const passageCoverageShortfall = (content: string): number => {
  const starts = overflowStarts(content.length);
  const covered =
    starts.length === 0
      ? EMBEDDING_WINDOW_CHARS
      : starts[starts.length - 1]! + EMBEDDING_WINDOW_CHARS;
  return Math.max(0, content.length - covered);
};
