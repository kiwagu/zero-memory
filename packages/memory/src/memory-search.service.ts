import {
  memoryAuthorKindSchema,
  memoryIdSchema,
  type MemoryKind,
  type MemorySearchHit,
} from '@workspace/contracts';
import type { Option } from 'oxide.ts';
import { z } from 'zod';

import type { Scope } from './scope.vo.js';

export interface MemorySearchParams {
  queryEmbedding: number[];
  queryText: string;
  scopes?: Scope[];
  kinds?: MemoryKind[];
  k?: number;
}

/** Near-duplicate probe result (boundary data — schema-first). */
export const similarMemorySchema = z.object({
  id: memoryIdSchema,
  content: z.string(),
  similarity: z.number(),
});
export type SimilarMemory = z.infer<typeof similarMemorySchema>;

/**
 * Dedup-probe result that also carries the existing memory's provenance, so
 * remember() can tell a safe duplicate from a contradiction, an authoritative
 * correction of a weaker (e.g. watcher) memory, or a same-session refinement
 * (the stamped `session` rides in `source`).
 */
export const similarMemoryWithProvenanceSchema = similarMemorySchema.extend({
  author_kind: memoryAuthorKindSchema,
  agent_name: z.string().nullable(),
  source: z.record(z.string(), z.unknown()).nullable(),
});
export type SimilarMemoryWithProvenance = z.infer<
  typeof similarMemoryWithProvenanceSchema
>;

/**
 * Supersede-candidate probe result: a same-owner neighbour above the aperture
 * floor, nearest first. Carries `scope` + `source` so the caller can run the
 * deterministic cross-project pair filter before showing it, plus
 * `kind`/`created_at` for the response hint.
 */
export const supersedeCandidateHitSchema = z.object({
  id: memoryIdSchema,
  content: z.string(),
  kind: z.string(),
  scope: z.string(),
  source: z.record(z.string(), z.unknown()).nullable(),
  created_at: z.string(),
  similarity: z.number(),
});
export type SupersedeCandidateHit = z.infer<typeof supersedeCandidateHitSchema>;

/**
 * Port: read side of the memory store (hybrid search + dedup probe).
 */
export interface IMemorySearchService {
  /** Hybrid (vector + full-text) search, RLS-scoped to the current user. */
  search(params: MemorySearchParams): Promise<MemorySearchHit[]>;

  /** Most similar valid memory in the exact scope above the threshold. */
  /**
   * The write-time duplicate probe.
   *
   * `windows` are the incoming record's OVERFLOW window vectors. They are not
   * used to find more matches — they are what lets the probe REFUSE one: the
   * primary vector is truncated at the model's input window, so without them
   * two long records that share an opening and differ afterwards look
   * identical, and the difference would be collapsed away unseen.
   */
  findSimilar(
    embedding: number[],
    scope: Scope,
    threshold?: number,
    windows?: number[][]
  ): Promise<Option<SimilarMemoryWithProvenance>>;

  /**
   * Nearest AUTHORITATIVE memory (not a provisional watcher write) to `embedding`
   * above the threshold, across the caller's readable scopes. Lets a provisional
   * writer defer when an authoritative memory already covers the fact.
   */
  findAuthoritativeCoverage(
    embedding: number[],
    threshold?: number
  ): Promise<Option<SimilarMemory>>;

  /**
   * Same-owner near-neighbours of `embedding` at or above `minSimilarity`
   * (default 0.80), live only, nearest first. `maxSimilarity` is optional and
   * unset by default — an above-dedup neighbour from another session or scope
   * is exactly what a write is most likely to replace, so nothing is excluded
   * from the top. Over-fetches (`limit`) so the caller can drop cross-project
   * pairs and still cap. Powers supersede-candidate feedback in remember().
   */
  findSupersedeCandidates(
    embedding: number[],
    options?: {
      minSimilarity?: number;
      maxSimilarity?: number;
      limit?: number;
    }
  ): Promise<SupersedeCandidateHit[]>;

  /**
   * Newest live memories of one exact scope (RLS applies), content + kind
   * only. Powers the model-written scope description sample.
   */
  listRecentByScope(
    scope: Scope,
    limit: number
  ): Promise<Array<{ content: string; kind: string }>>;
}
