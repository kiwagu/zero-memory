import {
  buildContextOutputSchema,
  type ContextMemory,
} from '@workspace/contracts';

/**
 * Fitting a briefing into the hook channel.
 *
 * A hook's context is not a free surface: past a client-side threshold the
 * whole payload is written to a file and replaced by a short preview, which is
 * the worst outcome available — the briefing LOOKS delivered while its most
 * valuable part goes unread, and the session proceeds believing it was
 * briefed. Measured on this project's own transcripts (1,188 hook attachments,
 * client 2.1.207–2.1.233): on the per-message hook nothing above ~10,000
 * characters was ever inlined, while everything below it was.
 *
 * So the briefing is composed against a budget, in priority order:
 *
 *   1. the project/thread line — tiny, and everything else depends on it;
 *   2. the standing rules — the owner's binding instructions, the one payload
 *      whose loss is unacceptable;
 *   3. the open loops — work someone handed over, already capped server-side;
 *   4. the memory pack — as many memories IN FULL as the remainder allows,
 *      then one-line stubs (kind, opening, id) for the rest.
 *
 * The stub tail is what keeps the degradation honest: a memory that did not
 * fit is still NAMED and addressable, instead of silently missing. Pulling one
 * is a `recall` by id away, and the pack itself is one `build_context` away —
 * the tool the agent is expected to call anyway.
 */

/**
 * Default hook budget — deliberately BELOW the ~10,000 boundary the
 * measurement inferred. 10,000 is where spilling began in the sample; the
 * largest payload actually observed inlined was 9,612, and the client wraps
 * what a hook emits, so the last few hundred characters are not ours to spend.
 * Sitting on the boundary would make a one-sentence rule the difference
 * between a briefing that arrives and one that does not.
 */
export const DEFAULT_HOOK_BUDGET_CHARS = 9_000;

/** How much of a memory a stub shows before the id. */
const STUB_CONTENT_CHARS = 100;

/**
 * Maximum stub-line count the memory pack gets as a floor, regardless of how
 * long the standing rules are. The floor prevents rules from consuming the
 * entire channel, leaving the briefing unable to name the memories the session
 * has not yet seen. Each stub line is a pointer the agent can pull by id, and
 * the pack itself is one `build_context` call away.
 */
export const MEMORY_FLOOR_STUBS = 10;

/**
 * Character cost per stub line: the memory kind, up to STUB_CONTENT_CHARS of
 * opening content, and the memory id.
 */
export const MEMORY_STUB_CHARS = 140;

/**
 * Calculates the memory floor in characters based on how many memories are
 * available: the smaller of memoryCount and MEMORY_FLOOR_STUBS, times the cost
 * per stub. Returns 0 when there are no memories to name.
 */
export const memoryFloorChars = (memoryCount: number): number =>
  Math.min(Math.max(memoryCount, 0), MEMORY_FLOOR_STUBS) * MEMORY_STUB_CHARS;

/**
 * Share of the channel held for the open loops whenever there are any. They
 * are the one part of a briefing the agent cannot learn another way — the
 * rules also live in the repository's instruction files, the pack is one
 * build_context away — so they get a FLOOR rather than whatever the rules
 * happen to leave.
 */
export const LOOPS_BUDGET_SHARE = 0.25;

/** What the composer's blank lines between sections cost, generously. */
const SECTION_SEPARATORS_CHARS = 16;

export interface SectionBudgets {
  /** The standing rules' ceiling; pinned rules may still exceed it. */
  readonly rules: number;
  /**
   * Space held for the memory pack, protecting it from rules overspend; the
   * floor yields to pinned standing rules, which stay exempt from the ceiling
   * and may displace it in the limit.
   */
  readonly memoryFloor: number;
}

/**
 * Splits the channel BEFORE the sections are rendered: the project line is
 * spent first, the open loops are held a floor, and the rules get the rest as
 * their ceiling. Without this split the rules took what they wanted and the
 * loops rendered into the remainder — on this project, nothing — and then
 * the rules did not fit either, so the briefing lost both. The loops render
 * afterwards against what the rules ACTUALLY used, so a short rules block
 * leaves them more than the floor.
 *
 * The memory floor is subtracted before the rules ceiling, so non-pinned rules
 * become headlines before the floor is lost; pinned rules stay outside the
 * ceiling and can end up displacing the floor in the limit.
 */
export const planSectionBudgets = (
  budgetChars: number,
  projectLineChars: number,
  hasLoops: boolean,
  memoryCount = 0
): SectionBudgets => {
  const memoryFloor = memoryFloorChars(memoryCount);
  return {
    memoryFloor,
    rules: Math.max(
      0,
      budgetChars -
        projectLineChars -
        (hasLoops ? Math.floor(budgetChars * LOOPS_BUDGET_SHARE) : 0) -
        memoryFloor -
        SECTION_SEPARATORS_CHARS
    ),
  };
};

/** Resolves the budget knob, falling back to the measured default. */
export const resolveHookBudgetChars = (raw: string | undefined): number => {
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0
    ? Math.floor(parsed)
    : DEFAULT_HOOK_BUDGET_CHARS;
};

/** One line naming a memory that did not fit: what it is, and how to get it. */
export const renderMemoryStub = (memory: ContextMemory): string => {
  const opening = memory.content
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, STUB_CONTENT_CHARS);
  const ellipsis = memory.content.trim().length > STUB_CONTENT_CHARS ? '…' : '';
  return `- [${memory.kind}] ${opening}${ellipsis} (id: ${memory.id})`;
};

/**
 * Marks a briefing whose memory pack had memories but not even one fit in the
 * budget. An empty pack (no memories at all) does not get this notice: there is
 * nothing to say, and an extra line trains the reader to ignore it.
 */
export const renderStarvedPackNotice = (topic: string, count: number): string =>
  `(${count} memory/memories for "${topic}" did not fit this briefing — ` +
  'they arrive in the next messages, or call build_context for them now.)';

export interface TrimmedPack {
  /**
   * The whole per-topic section: the pack as JSON carrying the memories that
   * fit, followed by stub lines for as many of the rest as the budget still
   * allows. Empty when not even one stub fits.
   */
  readonly text: string;
  /** Ids delivered IN FULL — the only ones a later briefing may dedup away. */
  readonly deliveredIds: string[];
  /**
   * Memories that did not arrive WHOLE, including the ones named by a stub —
   * a stub points at a memory, it does not deliver it.
   */
  readonly remaining: ContextMemory[];
  /**
   * True when the pack had memories but not even one LINE fit in the budget —
   * neither a whole memory NOR a stub. A stub list that did fit is a real,
   * if partial, delivery (`text` names real ids), not starvation; the
   * briefing is starved only when `text` came back empty.
   */
  readonly starved: boolean;
}

/**
 * Renders one topic's pack inside a character budget: whole memories while
 * they fit, then one-line stubs for as many of the rest as still fit, then a
 * count of what neither reached.
 *
 * Two properties are deliberate. Memories are kept WHOLE — the first that does
 * not fit ends the inlined section, because half a fact is worse than a named
 * pointer to a whole one. And when not a single memory fits, the JSON envelope
 * (entities, edges, field names) is dropped rather than shipped empty: an
 * empty envelope costs the same hundreds of characters as several stubs and
 * carries none of their information.
 *
 * A pack that does not parse is returned verbatim: this is a best-effort size
 * guard, never a filter that can lose a briefing.
 */
export const renderPackWithinBudget = (
  topic: string,
  payload: unknown,
  budgetChars: number
): TrimmedPack => {
  const header = `Persistent memory briefing for "${topic}" (from the zero-memory server):\n`;
  const parsed = buildContextOutputSchema.safeParse(payload);
  if (!parsed.success) {
    return {
      text: header + JSON.stringify(payload),
      deliveredIds: [],
      remaining: [],
      starved: false,
    };
  }
  const pack = parsed.data;
  const ordered: Array<{
    leg: 'memories' | 'linked' | 'recent';
    memory: ContextMemory;
  }> = [
    ...pack.memories.map((memory) => ({ leg: 'memories' as const, memory })),
    ...pack.linked_memories.map((memory) => ({
      leg: 'linked' as const,
      memory,
    })),
    ...pack.recent.map((memory) => ({ leg: 'recent' as const, memory })),
  ];

  const kept = {
    memories: [] as ContextMemory[],
    linked: [] as ContextMemory[],
    recent: [] as ContextMemory[],
  };
  const dropped: ContextMemory[] = [];
  const envelope = JSON.stringify({
    ...pack,
    memories: [],
    linked_memories: [],
    recent: [],
  }).length;
  let spent = header.length + envelope;

  for (const { leg, memory } of ordered) {
    const cost = JSON.stringify(memory).length + 1;
    if (dropped.length === 0 && spent + cost <= budgetChars) {
      kept[leg].push(memory);
      spent += cost;
    } else {
      dropped.push(memory);
    }
  }

  const deliveredIds = [...kept.memories, ...kept.linked, ...kept.recent].map(
    (memory) => memory.id
  );
  const parts: string[] = [];
  if (deliveredIds.length > 0) {
    parts.push(
      header +
        JSON.stringify({
          ...pack,
          memories: kept.memories,
          linked_memories: kept.linked,
          recent: kept.recent,
        })
    );
  } else {
    // No envelope was shipped, so its cost is not owed.
    spent = 0;
  }

  if (dropped.length > 0) {
    const intro =
      `Also in memory for "${topic}", named but not inlined — pull any by id ` +
      'with recall, or call build_context for the full pack:';
    const lines: string[] = [];
    let stubSpent = spent + intro.length;
    for (const memory of dropped) {
      const line = renderMemoryStub(memory);
      if (stubSpent + line.length + 1 > budgetChars) break;
      lines.push(line);
      stubSpent += line.length + 1;
    }
    const beyond = dropped.length - lines.length;
    if (lines.length > 0) {
      parts.push(
        [
          intro,
          ...lines,
          ...(beyond > 0 ? [`(+${beyond} more not listed)`] : []),
        ].join('\n')
      );
    }
  }

  return {
    text: parts.join('\n\n'),
    deliveredIds,
    remaining: dropped,
    // Starved means the render produced NOTHING — no whole memory AND no
    // stub line either. `deliveredIds.length === 0` alone is the wrong test:
    // it is true even when a stub list fully rendered (a real, non-empty
    // `parts` block naming real ids), which is strictly more useful than the
    // generic starved notice a caller would show in its place. `parts` is
    // empty exactly when the budget could not seat even the intro-plus-one-
    // stub floor, which is the one case that notice exists for.
    starved: parts.length === 0 && ordered.length > 0,
  };
};

export interface BudgetedSection {
  /** Shown in the omission notice when the section has to go. */
  readonly name: string;
  readonly text: string | null;
}

export interface ComposedBriefing {
  readonly text: string;
  readonly omitted: string[];
}

/**
 * Joins sections in STRICT priority order: the first section that does not fit
 * ends the briefing, and it plus everything after it is reported as omitted.
 *
 * Strict rather than best-fit on purpose. Best-fit lets a small low-priority
 * section slip in past a larger one that outranks it — measured on a real
 * briefing, two nearly-empty pack envelopes displaced the open loops, which is
 * the opposite of what the ordering is for.
 */
export const composeWithinBudget = (
  sections: readonly BudgetedSection[],
  budgetChars: number
): ComposedBriefing => {
  const parts: string[] = [];
  const omitted: string[] = [];
  let spent = 0;
  let full = false;
  for (const section of sections) {
    if (!section.text) continue;
    const cost = section.text.length + 2;
    // The first section is never dropped: with no project line the rest of
    // the briefing has nothing to attach to.
    if (full || (parts.length > 0 && spent + cost > budgetChars)) {
      full = true;
      omitted.push(section.name);
      continue;
    }
    parts.push(section.text);
    spent += cost;
  }
  if (omitted.length > 0) {
    parts.push(
      `(${omitted.join(' and ')} did not fit this briefing's channel budget — ` +
        'call build_context to get them in full.)'
    );
  }
  return { text: parts.join('\n\n'), omitted };
};
