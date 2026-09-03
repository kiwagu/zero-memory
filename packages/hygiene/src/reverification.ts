import { z } from 'zod';

/**
 * External re-verification: check core-scope world facts against the live
 * web.
 *
 * The corpus can only outgrow itself by taking in information from outside
 * it. The fast layer (core scope ∧ fact/reference — the deterministic
 * stratification the freshness ledger uses) is periodically re-checked
 * through the gateway's web-search call: `find_reverify_candidates` picks
 * the due memories (per-kind TTL, most-reinforced first, hard cap), the
 * checker searches and classifies, and only three honest outcomes exist —
 * stamp the ledger (current / unverifiable), raise a review-queue dispute
 * (outdated; the judge NEVER auto-supersedes), or leave the memory alone
 * when the check did not conclude. A provider without server-side web
 * search skips the whole exercise and says so: an unchecked record must
 * look unchecked.
 */

export const REVERIFY_VERDICTS = [
  'current',
  'outdated',
  'unverifiable',
] as const;

// Defaults make a minimal verdict parse: models omit fields that carry no
// signal (what_changed on a current fact). The gate independently requires
// confidence, so defaults can never stamp or queue by themselves.
export const reverifyVerdictSchema = z.object({
  /** How the memory relates to what the web says today. */
  verdict: z.enum(REVERIFY_VERDICTS),
  confidence: z.number().min(0).max(1).default(0),
  /** For `outdated`: what changed in the world since the memory was written. */
  what_changed: z.string().default(''),
  /** Best supporting source URL for the verdict, when one exists. */
  source_url: z.string().default(''),
  rationale: z.string().default(''),
});
export type ReverifyVerdict = z.infer<typeof reverifyVerdictSchema>;

/** Tuning knobs for one re-verification run. */
export interface ReverifyConfig {
  /** Facts about the outside world age slower than pointers to it. */
  ttlFactDays: number;
  /** References (links, docs, versions) go stale fastest. */
  ttlReferenceDays: number;
  /** Memories checked per run (the rollup's hard cap) — the spend brake. */
  maxCandidates: number;
  /** Server-side searches allowed per check. */
  maxSearches: number;
  /**
   * Verdicts below this confidence conclude nothing: no stamp, no dispute,
   * the memory stays due and a later run retries.
   */
  minConfidence: number;
}

export const DEFAULT_REVERIFY_CONFIG: ReverifyConfig = {
  // Mirrors DEFAULT_VERIFICATION_TTL (packages/memory): one notion of
  // staleness shared by the recall marker and the audit.
  ttlFactDays: 180,
  ttlReferenceDays: 90,
  maxCandidates: 10,
  maxSearches: 5,
  minConfidence: 0.6,
};

/** Is this verdict decisive enough to act on? Doubt leaves the memory alone. */
export const clearsReverifyGate = (
  verdict: ReverifyVerdict,
  minConfidence: number
): boolean => verdict.confidence >= minConfidence;
