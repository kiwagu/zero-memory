import { z } from 'zod';

/**
 * One generated holdout question: the LLM turns an owned memory into a
 * question that memory answers (the memory itself is the ground truth).
 */
export const roiProbeDraftSchema = z.object({
  memory_id: z.string(),
  question: z.string().min(8),
});
export type RoiProbeDraft = z.infer<typeof roiProbeDraftSchema>;

/** The prober's forced-tool payload: one question per input memory. */
export const roiProbeDraftsSchema = z.object({
  probes: z.array(roiProbeDraftSchema),
});
export type RoiProbeDrafts = z.infer<typeof roiProbeDraftsSchema>;

/**
 * One counterfactual verdict for a probe:
 * - `with_memory` — do the facts a real recall surfaced answer the question?
 * - `without_memory` — could a competent agent answer it correctly WITHOUT
 *   project memory, from general knowledge alone?
 * The headline metric is with_memory && !without_memory (exclusive).
 */
export const roiVerdictSchema = z.object({
  with_memory: z.boolean(),
  without_memory: z.boolean(),
  confidence: z.number().min(0).max(1),
});
export type RoiVerdict = z.infer<typeof roiVerdictSchema>;

/** A probe due for judging, with the facts a real recall surfaced. */
export interface RoiProbeCase {
  probeId: string;
  question: string;
  /** Ground truth: the source memory's id and content. */
  groundTruthId: string;
  groundTruth: string;
  /** What recall surfaced for the question (id + content), in rank order. */
  surfaced: { id: string; content: string }[];
}
