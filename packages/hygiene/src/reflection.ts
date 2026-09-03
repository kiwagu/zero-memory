import { z } from 'zod';

/**
 * Reflection: consolidate clusters of related episodes into one living fact.
 *
 * Episodes are transient by design — session logs, checkpoints, one-off
 * observations. When several of them tell one story (same scope, shared
 * entities, similar-but-not-duplicate content), the story deserves a single
 * consolidated memory that ranks as durable knowledge, while the sources stay
 * live and simply fade under ranking-time decay. Detection is a free SQL
 * rollup (`find_reflection_clusters`), the LLM distiller drafts the
 * consolidated fact, and the OWNER approves — the system never writes the
 * distillate into the corpus by itself.
 */

/** Kinds the consolidated memory may take, decided by content. */
export const REFLECTION_KINDS = ['fact', 'convention'] as const;

// Defaults make a minimal consolidate=false answer parse: models routinely
// omit the fields that carry no signal for a negative verdict (observed live
// on the first mirror dogfood). The gate independently requires non-empty
// content for a positive verdict, so the defaults can never queue an empty
// draft.
export const reflectionDistillationSchema = z.object({
  /** True when the cluster genuinely consolidates into one worthwhile fact. */
  consolidate: z.boolean(),
  /** Self-contained consolidated memory text, empty when consolidate=false. */
  content: z.string().default(''),
  /** Kind of the consolidated memory, by content. */
  kind: z.enum(REFLECTION_KINDS).default('fact'),
  confidence: z.number().min(0).max(1).default(0),
  rationale: z.string().default(''),
});
export type ReflectionDistillation = z.infer<
  typeof reflectionDistillationSchema
>;

/** Tuning knobs for one reflection detection run. */
export interface ReflectionConfig {
  /**
   * Cosine floor for a cluster edge. Matches the hygiene review-candidate
   * floor: the same "related" notion the pairwise scanner uses.
   */
  minSimilarity: number;
  /**
   * Cosine ceiling (exclusive). Matches the write-time same-scope dedup
   * threshold: at/above it a pair is dedup territory, not consolidation.
   */
  maxSimilarity: number;
  /**
   * Smallest cluster worth consolidating. Pairs stay the pairwise hygiene
   * judge's territory.
   */
  minClusterSize: number;
  /** Chronological members handed to the distiller (newest kept when over). */
  maxMembers: number;
  /**
   * Distillations below this confidence (or with consolidate=false) are
   * auto-dismissed instead of queued — the queue must stay short and honest.
   */
  distillConfidence: number;
}

export const DEFAULT_REFLECTION_CONFIG: ReflectionConfig = {
  minSimilarity: 0.78,
  maxSimilarity: 0.92,
  minClusterSize: 3,
  maxMembers: 10,
  distillConfidence: 0.6,
};
