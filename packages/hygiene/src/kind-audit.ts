import { z } from 'zod';

/**
 * Kind audit: demote changelog-style change notes out of durable kinds.
 *
 * Early extraction stored notes like "Updated the label to support the new
 * logic" as decision/convention. Those kinds carry ranking weight 1.0 and a
 * years-long half-life, so transient change reports permanently pollute the
 * top of recall. The audit is two-staged: a free deterministic prefilter
 * selects suspicious durable-kind memories, then the LLM judge confirms each
 * one before it is re-kinded to `episode` (weight 0.7, 30-day half-life) —
 * reversible, audited, no content is touched.
 */

/** Durable kinds worth auditing — the ones a change note must not hold. */
export const KIND_AUDIT_SUBJECT_KINDS = [
  'decision',
  'convention',
  'preference',
] as const;

// Change-note shapes observed in real extractions. Head-anchored openers
// ("Updated X…", "Added Y…") plus passive/progressive report phrases anywhere
// in the first sentence-ish stretch. Conservative on purpose: the prefilter
// only spends judge calls, it never re-kinds by itself.
const CHANGE_NOTE_PATTERNS: readonly RegExp[] = [
  /^(updated|added|renamed|removed|deleted|fixed|changed|moved|implemented|refactored|adjusted|introduced|reworked)\b/i,
  /\b(has|have) been (added|updated|renamed|removed|deleted|changed|moved|implemented|refactored|adjusted|introduced|reworked)\b/i,
  /\bwas (added|updated|renamed|removed|deleted|changed|moved|implemented|refactored|adjusted|introduced|reworked)\b/i,
  /\b(is|are) being (added|updated|renamed|removed|changed|moved|implemented|refactored|introduced)\b/i,
  /^in the current pr\b/i,
];

/**
 * Free prefilter: does this content read like a change note? Only gates which
 * memories are worth a judge call — the judge makes the actual call.
 */
export function isChangeNoteCandidate(content: string): boolean {
  const head = content.slice(0, 200);
  return CHANGE_NOTE_PATTERNS.some((pattern) => pattern.test(head));
}

export const kindAuditVerdictSchema = z.object({
  /** True when the memory is a transient change report, not durable knowledge. */
  change_note: z.boolean(),
  confidence: z.number().min(0).max(1),
  rationale: z.string(),
});
export type KindAuditVerdict = z.infer<typeof kindAuditVerdictSchema>;
