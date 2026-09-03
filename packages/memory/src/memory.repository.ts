import type { Option, Result } from 'oxide.ts';

import type { MemoryFragment } from './memory-fragment.do.js';

/**
 * The vectors that stand for one stored passage.
 *
 * More than one because the embedding model truncates its input to a fixed
 * window without saying so: covered by its primary vector alone, a memory is
 * searchable by its opening, which is where a handover record states the
 * situation rather than the instruction. Carried as a named shape so the
 * primary vector and the overflow windows can never be confused at a call
 * site.
 */
export interface PassageVectors {
  /**
   * Over the whole content — the model truncates it to its window as before.
   * The record's identity: dedup and the supersede probe compare THIS vector,
   * because they ask whether two whole records are the same fact.
   */
  primary: number[];
  /**
   * Successive overlapping windows covering everything the primary vector
   * could not reach, in order, each with the character offset it starts at.
   * Empty when the content fits the window whole.
   */
  overflow: Array<{ embedding: number[]; charStart: number }>;
}

/**
 * Port: persistence of memory fragments (write side).
 *
 * There is deliberately no delete: the store is ADD-only, `update` persists
 * lifecycle changes such as invalidation/supersession.
 */
export interface IMemoryRepository {
  /** Persists a new fragment together with its embedding vectors. */
  insert(
    fragment: MemoryFragment,
    vectors: PassageVectors
  ): Promise<Result<void, string>>;

  findOneById(id: string): Promise<Option<MemoryFragment>>;

  /** Persists mutated aggregate state (lifecycle, sharing). */
  update(fragment: MemoryFragment): Promise<Result<void, string>>;

  /**
   * Applies a completed language canonicalization to one row: content becomes
   * the English rendering, the source is preserved in content_original, the new
   * vectors replace the original-language ones, and translation_status is
   * marked 'done'. Used by the write-triggered background canonicalization.
   */
  applyTranslation(
    id: string,
    params: {
      content: string;
      contentOriginal: string;
      contentLang: string;
      vectors: PassageVectors;
    }
  ): Promise<Result<void, string>>;

  /**
   * Retires a pending canonicalization that turned out to be a no-op: the
   * translator judged the source already English (the cheap write-path detector
   * over-triggered on a stray non-Latin char). Marks the row 'skipped' and
   * clears content_original so no meaningless "Original (en)" is retained —
   * content and embedding stay as first stored.
   */
  markTranslationSkipped(id: string): Promise<Result<void, string>>;
}
