import { z } from 'zod';

/**
 * One judge verdict, two axes per recalled memory:
 * - `useful` — did the agent actually USE it in the transcript that followed
 *   (cited it, leaned on it in a decision, let it change course), or was it
 *   merely shown and ignored?
 * - `relevant` — was it at least ON-TOPIC for what the session was doing,
 *   even if unused? (Feeds context precision: how much of what recall
 *   surfaces is pertinent at all. useful=true implies relevant=true.)
 * - `misled` — the negative valence: the agent FOLLOWED the memory and the
 *   transcript shows it was wrong, stale, or later corrected (a stored fix
 *   that failed, a decision reality contradicted). Strictly stronger than
 *   "unused": misled=true implies useful=false. Optional so older stored
 *   verdicts and conservative judges parse unchanged; absent means false.
 * `confidence` is the judge's certainty; the metrics count a verdict only
 * above a threshold, and the aggregates smooth residual noise.
 */
export const usefulnessVerdictSchema = z.object({
  mem_id: z.string(),
  useful: z.boolean(),
  relevant: z.boolean(),
  misled: z.boolean().optional(),
  confidence: z.number().min(0).max(1),
});
export type UsefulnessVerdict = z.infer<typeof usefulnessVerdictSchema>;

/** The forced-tool payload: one verdict per recalled memory. */
export const usefulnessVerdictsSchema = z.object({
  verdicts: z.array(usefulnessVerdictSchema),
});
export type UsefulnessVerdicts = z.infer<typeof usefulnessVerdictsSchema>;
