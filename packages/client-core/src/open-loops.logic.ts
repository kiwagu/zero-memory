import {
  buildContextOutputSchema,
  type BriefingWork,
  type ContextMemory,
} from '@workspace/contracts';

/**
 * Pure open-loops presentation logic shared by the briefing hooks: split the
 * loops out of a briefing payload (so the prominent section does not
 * duplicate the JSON dump) and render them as a visible text block.
 * Instruction hygiene: loops are presented as RECORDED data ("open loops
 * recorded"), never as imperatives — the agent decides what to act on.
 */

export interface OpenLoopsSplit {
  /**
   * The payload with the open-loops fields drained, ready to dump as the
   * regular briefing JSON — or the input verbatim when it does not parse as
   * a briefing pack (older server: nothing to split).
   */
  payload: unknown;
  loops: ContextMemory[];
  total: number;
  /**
   * Open loops past the briefing window that sit on no card: not listed, only
   * counted, so the section can say they exist.
   */
  aged: number;
  /** The board's work in progress, when the server sent a summary. */
  work: BriefingWork | null;
}

/** Splits open loops out of an UNPARSED briefing payload — never throws. */
export const splitOpenLoops = (payload: unknown): OpenLoopsSplit => {
  const parsed = buildContextOutputSchema.safeParse(payload);
  if (!parsed.success)
    return { payload, loops: [], total: 0, aged: 0, work: null };
  const { open_loops, open_loops_total, open_loops_aged, work, ...rest } =
    parsed.data;
  return {
    payload: {
      ...rest,
      open_loops: [],
      open_loops_total: 0,
      open_loops_aged: 0,
    },
    loops: open_loops,
    total: open_loops_total,
    aged: open_loops_aged,
    work: work ?? null,
  };
};

/**
 * Merges the loops of several splits (e.g. the project and branch briefings,
 * which brief the same scopes and so carry the same loops): union by id,
 * NEWEST first — the loops most likely still in flight are the ones a
 * trimmed section must keep. The totals are the max, not the sum — each
 * briefing already reported the whole scope-wide count.
 */
export const mergeOpenLoops = (
  splits: readonly OpenLoopsSplit[]
): {
  loops: ContextMemory[];
  total: number;
  aged: number;
  work: BriefingWork | null;
} => {
  const byId = new Map<string, ContextMemory>();
  for (const split of splits) {
    for (const loop of split.loops) {
      if (!byId.has(loop.id)) byId.set(loop.id, loop);
    }
  }
  const loops = [...byId.values()].sort((a, b) =>
    b.created_at.localeCompare(a.created_at)
  );
  const total = Math.max(0, ...splits.map((split) => split.total));
  const aged = Math.max(0, ...splits.map((split) => split.aged));
  // Every briefing of one session pins the same project, so the first
  // summary is the summary.
  const work = splits.find((split) => split.work)?.work ?? null;
  return { loops, total: Math.max(total, loops.length), aged, work };
};

/** Whole days a loop has been open (unparsable dates render as 0). */
const ageDays = (createdAt: string, now: Date): number => {
  const created = Date.parse(createdAt);
  if (Number.isNaN(created)) return 0;
  return Math.max(0, Math.floor((now.getTime() - created) / 86_400_000));
};

/** How much of a loop a one-line stub shows before its id. */
const LOOP_STUB_CHARS = 140;

/**
 * The line naming the loops the server no longer lists: open past the
 * briefing window and on no card. Before it existed they vanished from every
 * briefing without a trace, and unfinished work went unseen for weeks.
 */
const agedLoopsLine = (aged: number): string =>
  `(${aged} older open loop${aged === 1 ? '' : 's'}, past the briefing ` +
  'window and on no card, not listed here; recall with kinds task and ' +
  'open-question lists them)';

/**
 * The prominent "Open loops" text block for a briefing, or null when there
 * is nothing to show. In the order given (newest first after merging), with
 * a staleness badge, capped upstream (the server caps the list and reports
 * the scope-wide total).
 *
 * `budgetChars` bounds the rendered block. The list is limited by COUNT, not
 * by cutting a handover mid-sentence: a loop arrives whole while it fits, and
 * one too long to fit arrives as a one-line stub — kind, age, opening, id —
 * instead of ending the section. A single long handover used to consume the
 * whole allowance and leave the section empty. Loops beyond what fits are
 * counted into the "+N more" tail, never silently gone.
 *
 * `aged` counts the open loops past the briefing window that sit on no card.
 * They are not listed, but a closing line says they exist, also when no loop
 * is inside the window and the section is that line alone.
 */
export const renderOpenLoopsSection = (
  loops: readonly ContextMemory[],
  total: number,
  now: Date = new Date(),
  budgetChars = Number.POSITIVE_INFINITY,
  aged = 0
): string | null => {
  const agedLine = aged > 0 ? agedLoopsLine(aged) : null;
  if (loops.length === 0) {
    return agedLine !== null && agedLine.length <= budgetChars
      ? agedLine
      : null;
  }
  const header =
    `Open loops recorded in persistent memory (${total} active, newest ` +
    'first; a loop stays listed until closed with close_loop or superseded ' +
    'by a remember):\n';
  // The tail is not free either: leave room for the widest "+N more" it could
  // grow into, so adding the last line can never overflow.
  const tail =
    `\n(+${total} more active open loops)`.length +
    (agedLine ? agedLine.length + 1 : 0);

  const lines: string[] = [];
  let spent = header.length;
  for (const loop of loops) {
    const age = ageDays(loop.created_at, now);
    const badge = `[${loop.kind}${age > 0 ? `, open ${age}d` : ''}]`;
    const full = `- ${badge} ${loop.content} (id: ${loop.id})`;
    const flat = loop.content.replace(/\s+/gu, ' ').trim();
    const stub =
      `- ${badge} ${flat.slice(0, LOOP_STUB_CHARS).trimEnd()}` +
      `${flat.length > LOOP_STUB_CHARS ? '…' : ''} (id: ${loop.id})`;
    const line = spent + full.length + 1 + tail <= budgetChars ? full : stub;
    if (spent + line.length + 1 + tail > budgetChars) break;
    lines.push(line);
    spent += line.length + 1;
  }
  if (lines.length === 0) return null;

  const beyond = Math.max(0, total - lines.length);
  const more = beyond > 0 ? `\n(+${beyond} more active open loops)` : '';
  return header + lines.join('\n') + more + (agedLine ? `\n${agedLine}` : '');
};
