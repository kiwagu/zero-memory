import { z } from 'zod';

/**
 * Loop closure: auto-close open loops whose completion is asserted by newer
 * memories.
 *
 * An open loop (kind task / open-question) surfaces in every briefing until
 * closed, but closing depends on the finishing agent calling close_loop or
 * declaring a supersede — a diligence step that gets missed. The hygiene
 * cycle pairs each live loop with the newest similar non-loop memories
 * written after it (`find_loop_closure_evidence`) and asks a judge whether
 * the evidence asserts the loop's work is COMPLETE. Only a high-confidence
 * "closed" verdict acts; it closes the loop with the same reversible
 * invalidation close_loop uses (ADD-only, audited, restorable), stamping the
 * evidence memory as the successor. Anything less leaves the loop open —
 * a wrongly-closed task is worse than a lingering one.
 */

// Defaults make a minimal closed=false answer parse: models routinely omit
// fields that carry no signal for a negative verdict. The gate independently
// requires an evidence id for a positive verdict.
export const loopClosureVerdictSchema = z.object({
  /** True when the evidence asserts the loop's work is complete/answered. */
  closed: z.boolean(),
  /** Id of the ONE evidence memory that asserts completion (empty if none). */
  evidence_id: z.string().default(''),
  confidence: z.number().min(0).max(1).default(0),
  rationale: z.string().default(''),
});
export type LoopClosureVerdict = z.infer<typeof loopClosureVerdictSchema>;

/** Tuning knobs for one loop-closure detection run. */
export interface LoopClosureConfig {
  /**
   * Cosine floor for evidence candidates. Deliberately BELOW the hygiene
   * review floor: candidates only feed a judge whose default is "leave
   * open", so recall matters more than precision here — a completion memory
   * often paraphrases the task loosely.
   */
  minSimilarity: number;
  /** Strongest evidence memories handed to the judge per loop. */
  maxEvidence: number;
  /**
   * Verdicts below this confidence leave the loop open. High on purpose:
   * an auto-closed loop disappears from briefings, and topic similarity
   * alone is a known-imprecise signal — the judge must see an explicit
   * completion assertion, not related work.
   */
  closeConfidence: number;
  /** Judge-call cap per run — spend brake for the system-wide sweep. */
  maxJudgements: number;
}

export const DEFAULT_LOOP_CLOSURE_CONFIG: LoopClosureConfig = {
  minSimilarity: 0.6,
  maxEvidence: 3,
  closeConfidence: 0.85,
  maxJudgements: 10,
};
