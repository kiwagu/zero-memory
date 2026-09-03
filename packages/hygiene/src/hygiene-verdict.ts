import { z } from 'zod';

/**
 * How the judge relates a pair of same-owner memories (A = scan subject,
 * B = neighbour):
 *   - duplicate       — the same durable fact, possibly reworded or in another
 *                       language (what same-scope write-time dedup missed);
 *   - a_supersedes_b  — same subject, A is the corrected/complete version that
 *                       should replace B;
 *   - b_supersedes_a  — same subject, B replaces A;
 *   - contradiction   — mutually inconsistent about the same subject, but
 *                       neither is clearly the replacement (needs a human);
 *   - complementary   — related facets of the same topic that are BOTH valid,
 *                       with no replacement between them (keep both). Its own
 *                       relation so the judge is not forced to mislabel these
 *                       as `supersedes`, which was the dominant false positive
 *                       on authoritative-vs-authoritative pairs;
 *   - unrelated       — different subjects; both legitimately coexist.
 */
export const HYGIENE_RELATIONS = [
  'duplicate',
  'a_supersedes_b',
  'b_supersedes_a',
  'contradiction',
  'complementary',
  'unrelated',
] as const;

export const hygieneVerdictSchema = z.object({
  relation: z.enum(HYGIENE_RELATIONS),
  confidence: z.number().min(0).max(1),
  rationale: z.string(),
});
export type HygieneVerdict = z.infer<typeof hygieneVerdictSchema>;

/** Tuning knobs for one hygiene scan. Single place to adjust the pipeline. */
export interface HygieneConfig {
  /** Only scan memories created within this many days (incremental coverage). */
  lookbackDays: number;
  /** Similarity floor for a neighbour to be considered a candidate. */
  minSimilarity: number;
  /** Max neighbours judged per scanned memory. */
  maxCandidates: number;
  /** A verdict at or above this confidence is auto-resolved (Tier-AUTO). */
  autoConfidence: number;
  /**
   * Floor for auto-SUPERSEDING, stricter than `autoConfidence`: a supersede
   * hides content that differs from the winner's, so a wrong call loses
   * information a duplicate-forget would not. A supersedes verdict below this
   * confidence is queued for a human even when it clears `autoConfidence`.
   */
  autoInvalidateConfidence: number;
  /**
   * A kind-audit verdict at or above this confidence re-kinds the memory to
   * `episode`. Lower than autoConfidence: a re-kind only demotes ranking
   * weight — far less destructive than an invalidation.
   */
  rekindConfidence: number;
}

export const DEFAULT_HYGIENE_CONFIG: HygieneConfig = {
  lookbackDays: 7,
  minSimilarity: 0.78,
  maxCandidates: 3,
  autoConfidence: 0.9,
  autoInvalidateConfidence: 0.95,
  rekindConfidence: 0.8,
};
