import {
  buildContextOutputSchema,
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
}

/** Splits open loops out of an UNPARSED briefing payload — never throws. */
export const splitOpenLoops = (payload: unknown): OpenLoopsSplit => {
  const parsed = buildContextOutputSchema.safeParse(payload);
  if (!parsed.success) return { payload, loops: [], total: 0 };
  const { open_loops, open_loops_total, ...rest } = parsed.data;
  return {
    payload: { ...rest, open_loops: [], open_loops_total: 0 },
    loops: open_loops,
    total: open_loops_total,
  };
};

/**
 * Merges the loops of several splits (e.g. the project and branch briefings,
 * which brief the same scopes and so carry the same loops): union by id,
 * oldest first. The total is the max, not the sum — each briefing already
 * reported the whole scope-wide count.
 */
export const mergeOpenLoops = (
  splits: readonly OpenLoopsSplit[]
): { loops: ContextMemory[]; total: number } => {
  const byId = new Map<string, ContextMemory>();
  for (const split of splits) {
    for (const loop of split.loops) {
      if (!byId.has(loop.id)) byId.set(loop.id, loop);
    }
  }
  const loops = [...byId.values()].sort((a, b) =>
    a.created_at.localeCompare(b.created_at)
  );
  const total = Math.max(0, ...splits.map((split) => split.total));
  return { loops, total: Math.max(total, loops.length) };
};

/** Whole days a loop has been open (unparsable dates render as 0). */
const ageDays = (createdAt: string, now: Date): number => {
  const created = Date.parse(createdAt);
  if (Number.isNaN(created)) return 0;
  return Math.max(0, Math.floor((now.getTime() - created) / 86_400_000));
};

/**
 * The prominent "Open loops" text block for a briefing, or null when there
 * is nothing to show. Oldest first with a staleness badge, capped upstream
 * (the server caps the list and reports the scope-wide total).
 *
 * `budgetChars` bounds the rendered block: loops beyond what fits are counted
 * into the "+N more" tail rather than pushing the section over a delivery
 * channel's limit. Trimming keeps the leading (oldest) loops for the same
 * reason the list is ordered that way — stale work is the kind that gets
 * forgotten — and an omitted loop is still counted, never silently gone.
 */
export const renderOpenLoopsSection = (
  loops: readonly ContextMemory[],
  total: number,
  now: Date = new Date(),
  budgetChars = Number.POSITIVE_INFINITY
): string | null => {
  if (loops.length === 0) return null;
  const header =
    `Open loops recorded in persistent memory (${total} active, oldest ` +
    'first; a loop stays listed until closed with close_loop or superseded ' +
    'by a remember):\n';
  const rendered = loops.map((loop) => {
    const age = ageDays(loop.created_at, now);
    const staleness = age > 0 ? `, open ${age}d` : '';
    return `- [${loop.kind}${staleness}] ${loop.content} (id: ${loop.id})`;
  });

  const lines: string[] = [];
  let spent = header.length;
  for (const line of rendered) {
    // The tail is not free either: leave room for the widest "+N more" it
    // could grow into, so adding the last line can never overflow.
    const tail = `\n(+${total} more active open loops)`.length;
    if (spent + line.length + 1 + tail > budgetChars) break;
    lines.push(line);
    spent += line.length + 1;
  }
  if (lines.length === 0) return null;

  const beyond = Math.max(0, total - lines.length);
  const more = beyond > 0 ? `\n(+${beyond} more active open loops)` : '';
  return header + lines.join('\n') + more;
};
