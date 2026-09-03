import type { ExportedMemory } from '@workspace/contracts';
import { inject } from '@workspace/di';

/**
 * Port: bulk read of the caller's accessible memories for a Markdown export.
 *
 * Deliberately separate from {@link IMemoryRepository} (the write side, which
 * deals in domain aggregates): export needs flat, full-fidelity rows — exactly
 * the fields the file renderer emits — not reconstructed aggregates. Runs as
 * the current user, so RLS is the visibility boundary.
 */
export interface IMemoryExportReader {
  /**
   * Every memory the caller can read, in a stable order (created_at, id).
   * When `scopes` is given, restricts the read to those exact scopes.
   */
  listAll(scopes?: string[]): Promise<ExportedMemory[]>;
  /**
   * One full-fidelity memory by canonical id, or null when it does not exist
   * OR the caller cannot see it — RLS makes the two indistinguishable by
   * design. Serves the `zm://memory/{id}` resource read, where the full
   * untruncated row is the whole point.
   */
  findById(id: string): Promise<ExportedMemory | null>;
}

export const MEMORY_EXPORT_READER = Symbol.for(
  'zero-memory:memory-export-reader'
);

export const injectMemoryExportReader = () => inject(MEMORY_EXPORT_READER);
