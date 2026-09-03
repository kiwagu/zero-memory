import { PORTABLE_SUBJECT_KINDS } from '@workspace/contracts';
import { z } from 'zod';

/**
 * Portability audit: propose moving portable world facts out of project
 * scopes into the owner's personal core scope.
 *
 * A fact about a tool or technology written during project work lands in
 * that project's scope by the conservative write-time default — and stays
 * invisible to every other project's sessions and to the core-scope external
 * re-verification pass. The audit is two-staged like the kind audit: a free
 * deterministic prefilter (the `find_portability_candidates` rollup — live
 * private project-scope memories of a world-facing kind, most-reinforced
 * first, hard-capped) selects candidates, then the LLM judge confirms it.
 * A confident verdict only ever files a REVIEWABLE proposal: the owner
 * approves or dismisses from the dashboard, and only approval re-scopes.
 */

/**
 * Kinds worth auditing — the ones whose truth can outlive a project.
 *
 * `gotcha` belongs here even though a promoted gotcha will never be
 * externally re-verified (that pass reads core ∧ fact/reference): the point
 * of promotion is cross-project VISIBILITY, and a gotcha about a public tool
 * is the class that gets rediscovered project after project — the very
 * evidence that motivated this audit. `convention` and `preference` stay
 * out: their oracle is the owner, not the outside world, so "portable" is
 * not a property a judge can read off their content.
 *
 * The ENFORCING copy of this list is the kind filter inside
 * `find_portability_candidates`; this constant documents it, and the e2e
 * rollup spec fails if the two drift apart.
 */
export const PORTABILITY_SUBJECT_KINDS = PORTABLE_SUBJECT_KINDS;

// Defaults make a minimal portable=false answer parse: models routinely omit
// fields that carry no signal for a negative verdict (the reflection
// distiller lesson). The gate independently requires portable=true plus
// confidence, so the defaults can never queue a proposal by themselves.
export const portabilityVerdictSchema = z.object({
  /** True when the memory is a portable world fact, free of project context. */
  portable: z.boolean(),
  confidence: z.number().min(0).max(1).default(0),
  rationale: z.string().default(''),
});
export type PortabilityVerdict = z.infer<typeof portabilityVerdictSchema>;

/** Tuning knobs for one portability detection run. */
export interface PortabilityConfig {
  /** Judge calls per run (the rollup's hard cap) — the spend brake. */
  maxCandidates: number;
  /**
   * Verdicts below this confidence (or with portable=false) are auto-
   * dismissed instead of queued — the queue must stay short and honest.
   */
  proposeConfidence: number;
}

export const DEFAULT_PORTABILITY_CONFIG: PortabilityConfig = {
  maxCandidates: 10,
  proposeConfidence: 0.7,
};

/**
 * Should this verdict reach the owner's queue? Conservative on purpose:
 * doubt dismisses (mirrors the reflection gate). Exported pure for tests.
 */
export const clearsPortabilityGate = (
  verdict: PortabilityVerdict,
  minConfidence: number
): boolean => verdict.portable && verdict.confidence >= minConfidence;
