import type { ContextMemory } from '@workspace/contracts';

import { renderOpenLoopsSection } from './open-loops.logic.js';

/**
 * The anchor a client emits when its context is about to be compacted.
 *
 * WHY IT IS SHAPED AS AN INSTRUCTION. Measured on a real compaction: what a
 * pre-compaction hook prints is handed to the SUMMARIZING model as additional
 * instructions — it is not prepended to the context that survives. So text
 * written as content only survives if the summarizer happens to echo it, while
 * text written as a rule about the summary is acted on. Everything here is
 * therefore addressed to whoever is writing the summary.
 *
 * WHY IT CARRIES SO LITTLE. The briefing is re-delivered on its own right after
 * the boundary, so re-sending the memory pack here would buy nothing and spend
 * the summarizer's attention twice. The anchor carries only what the transcript
 * cannot reconstruct once it is gone: which project and conversation this work
 * belongs to, and which loops were left open. Everything else is reloaded.
 *
 * Instruction hygiene, as everywhere loops are surfaced: the loops themselves
 * stay RECORDED DATA. The single imperative is about summary fidelity — never
 * about which work to pick up.
 */

/**
 * How much of the compaction input the anchor may claim.
 *
 * Deliberately far below the ~10K the per-message hook channel tolerates. This
 * text competes for attention with the entire conversation being summarized,
 * and a long anchor would push the summarizer toward preserving the anchor
 * instead of the session. Loops beyond the budget are still COUNTED in the
 * section's "+N more" tail, so a trimmed anchor understates nothing.
 */
export const DEFAULT_ANCHOR_BUDGET_CHARS = 2_000;

export interface CompactionAnchorInput {
  /** The memory project this work belongs to, when one is known. */
  readonly scope: string | null;
  /** This conversation's own thread token, when one was resolved. */
  readonly thread: string | null;
  readonly loops: readonly ContextMemory[];
  /** Scope-wide loop count, which may exceed the loops handed over. */
  readonly total: number;
}

const HEADER =
  'zero-memory — preserve the block below in the summary, verbatim. It was ' +
  'read from persistent memory rather than from this conversation, so once ' +
  'the transcript is condensed nothing remains from which to reconstruct it.';

const FOOTER =
  '(The full memory pack is not repeated here; it is reloaded with ' +
  'build_context after compaction. This block is the part that would ' +
  'otherwise be lost.)';

/** The identity line, or null when neither half is known. */
const renderIdentity = (
  scope: string | null,
  thread: string | null
): string | null => {
  const parts = [
    ...(scope ? [`PROJECT: ${scope}`] : []),
    ...(thread ? [`THREAD: ${thread}`] : []),
  ];
  return parts.length > 0 ? parts.join(' · ') : null;
};

/**
 * The anchor text, or null when there is nothing worth anchoring — no identity
 * and no open loops. Silence is the right output then: an anchor announcing
 * that it has nothing to say would still cost the summarizer a read.
 */
export const renderCompactionAnchor = (
  input: CompactionAnchorInput,
  now: Date = new Date(),
  budgetChars: number = DEFAULT_ANCHOR_BUDGET_CHARS
): string | null => {
  const identity = renderIdentity(input.scope, input.thread);

  // The fixed framing is paid first; the loops get whatever is left. Trimming
  // the loops (which the section does by count, keeping the oldest) is right
  // where truncating the instruction would not be — a half-sentence rule about
  // summary fidelity is worse than no rule.
  const spent =
    HEADER.length + FOOTER.length + (identity ? identity.length : 0) + 6;
  const loopsSection = renderOpenLoopsSection(
    input.loops,
    input.total,
    now,
    Math.max(0, budgetChars - spent)
  );

  if (identity === null && loopsSection === null) return null;

  return [
    HEADER,
    ...(identity ? [identity] : []),
    ...(loopsSection ? [loopsSection] : []),
    FOOTER,
  ].join('\n\n');
};
