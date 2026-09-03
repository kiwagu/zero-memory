import { createHash } from 'node:crypto';

export interface Chunk {
  conversationId: string;
  text: string;
  /** sha256 hex of the chunk text — the ingest idempotency key. */
  hash: string;
  /** Project hint captured with the buffered text (transcript cwd). */
  projectHint?: string;
  /** `mem_` ids surfaced by recall / build_context while this text buffered —
   * the usefulness judge's "shown" set for this chunk. */
  recalledIds: string[];
}

export interface ChunkerOptions {
  /** Flush a conversation buffer once it reaches this many characters. */
  maxChars: number;
  /** Flush a conversation buffer after this long without new text. */
  idleMs: number;
  /**
   * Carry the last N characters of a size-flushed chunk into the next one, so
   * a fact straddling the cut is seen whole. 0 disables. Re-extracted overlap
   * facts collapse via the server's semantic dedup, so this never duplicates.
   */
  overlapChars?: number;
  /** Clock override for tests. */
  now?: () => number;
}

interface ConversationBuffer {
  parts: string[];
  /** Total buffered chars, including any carried-over overlap prefix. */
  length: number;
  /** Chars appended since the last flush — guards idle re-sends of overlap. */
  freshChars: number;
  lastAppendAt: number;
  projectHint?: string;
  /** Recall-surfaced ids accumulated since the last flush. */
  recalledIds: Set<string>;
}

export const sha256 = (text: string): string =>
  createHash('sha256').update(text, 'utf8').digest('hex');

/**
 * Accumulates conversational text per conversation and releases it in
 * chunks: when a buffer reaches `maxChars` (size flush, returned from
 * `append`) or when it sat idle for `idleMs` (collected via `flushIdle`,
 * called from the watcher's timer).
 *
 * A size flush retains an overlap tail so the next chunk carries the boundary
 * context; an idle flush does not (the conversation went quiet, no follow-up
 * to give context to).
 */
export class ConversationChunker {
  readonly #maxChars: number;
  readonly #idleMs: number;
  readonly #overlapChars: number;
  readonly #now: () => number;
  readonly #buffers = new Map<string, ConversationBuffer>();

  constructor(options: ChunkerOptions) {
    this.#maxChars = options.maxChars;
    this.#idleMs = options.idleMs;
    this.#now = options.now ?? (() => Date.now());
    // Overlap can never reach the flush cap, or a chunk could be pure overlap.
    this.#overlapChars = Math.min(
      Math.max(0, options.overlapChars ?? 0),
      Math.max(0, options.maxChars - 1)
    );
  }

  /** Buffers text; returns the flushed chunks when the size cap is hit. */
  append(
    conversationId: string,
    text: string,
    recalledIds: readonly string[] = [],
    projectHint?: string
  ): Chunk[] {
    if (text.length === 0) {
      return [];
    }
    const buffer = this.#buffers.get(conversationId) ?? {
      parts: [],
      length: 0,
      freshChars: 0,
      lastAppendAt: this.#now(),
      recalledIds: new Set<string>(),
    };
    buffer.parts.push(text);
    buffer.length += text.length + 1;
    buffer.freshChars += text.length + 1;
    buffer.lastAppendAt = this.#now();
    buffer.projectHint = projectHint ?? buffer.projectHint;
    for (const id of recalledIds) {
      buffer.recalledIds.add(id);
    }
    this.#buffers.set(conversationId, buffer);

    if (buffer.length >= this.#maxChars) {
      const chunk = this.#flush(conversationId, true);
      return chunk ? [chunk] : [];
    }
    return [];
  }

  /** Chunks whose conversations have been idle for at least `idleMs`. */
  flushIdle(): Chunk[] {
    const cutoff = this.#now() - this.#idleMs;
    const flushed: Chunk[] = [];
    for (const [conversationId, buffer] of [...this.#buffers]) {
      if (buffer.lastAppendAt > cutoff) {
        continue;
      }
      if (buffer.freshChars > 0) {
        const chunk = this.#flush(conversationId, false);
        if (chunk) {
          flushed.push(chunk);
        }
      } else {
        // Only carried-over overlap remains — already extracted, drop it.
        this.#buffers.delete(conversationId);
      }
    }
    return flushed;
  }

  /** Everything still buffered (shutdown path). */
  flushAll(): Chunk[] {
    return [...this.#buffers.keys()]
      .map((conversationId) => this.#flush(conversationId, false))
      .filter((chunk): chunk is Chunk => chunk !== null);
  }

  #flush(conversationId: string, reseedOverlap: boolean): Chunk | null {
    const buffer = this.#buffers.get(conversationId);
    if (!buffer || buffer.freshChars === 0) {
      this.#buffers.delete(conversationId);
      return null;
    }
    const text = buffer.parts.join('\n');

    const overlap = reseedOverlap ? this.#tail(text) : '';
    if (overlap.length > 0) {
      // Overlap is context-only carry-over; the recalled ids left with the
      // flushed chunk, so the reseeded buffer starts with an empty set.
      this.#buffers.set(conversationId, {
        parts: [overlap],
        length: overlap.length,
        freshChars: 0,
        lastAppendAt: buffer.lastAppendAt,
        projectHint: buffer.projectHint,
        recalledIds: new Set<string>(),
      });
    } else {
      this.#buffers.delete(conversationId);
    }

    return {
      conversationId,
      text,
      hash: sha256(text),
      projectHint: buffer.projectHint,
      recalledIds: [...buffer.recalledIds],
    };
  }

  /** Last `overlapChars` of the chunk, trimmed to start at a line boundary. */
  #tail(text: string): string {
    if (this.#overlapChars === 0) {
      return '';
    }
    const slice = text.slice(-this.#overlapChars);
    if (slice.length === text.length) {
      // The whole chunk fits in the overlap window — nothing new would follow.
      return '';
    }
    const newline = slice.indexOf('\n');
    return newline >= 0 ? slice.slice(newline + 1) : slice;
  }
}
