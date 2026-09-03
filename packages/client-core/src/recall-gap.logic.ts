/**
 * When to remind a session that memory exists — the decision, with no IO.
 *
 * The problem this addresses is measured, not assumed: sessions write to memory
 * far more often than they read from it, and a reminder made of instructions
 * alone did not move that ratio. What did move it was a reminder delivered at a
 * moment the session could still act on, gated so it stays rare.
 *
 * THE GATE IS THE WHOLE DESIGN. Every reminder is suppressed once the session has
 * consulted memory even once, because at that point the habit is present and
 * further prompting is noise — and noise is not a neutral cost here: a reminder
 * that cries wolf gets ignored or switched off, which is strictly worse than
 * never having sent it. That is also why each reminder fires at most once per
 * session. In a dogfood across 34 sessions this produced four reminders in nine
 * days, and the one measured on a failing tool took a session from zero reads to
 * eight.
 *
 * Deliberately NOT a gate on the tools themselves: blocking work until the agent
 * reads memory would be unenforceable on clients without hooks, and would get
 * disabled on the ones that have them.
 */

import { toolBaseName } from './recall-tools.logic.js';

/** What a session has done with memory so far, and what it has been told. */
export interface RecallGapCounters {
  /** Calls to the read tools. The gate for every reminder. */
  readonly recalls: number;
  /** Calls to the write tool. Only the end-of-turn reminder needs it. */
  readonly remembers: number;
  /** The failing-tool reminder already fired this session. */
  readonly remindedOnFailure: boolean;
  /** The end-of-turn reminder already fired this session. */
  readonly remindedOnTurnEnd: boolean;
  /** The search reminder already fired this session. */
  readonly remindedOnSearch: boolean;
}

/**
 * The semantic moment a firing event represents.
 *
 * Clients spell their events differently and only differ in case where they
 * agree at all, so events are matched case-insensitively and an unrecognized one
 * is simply inert — a client that lacks a moment (no failure event, say) needs no
 * special handling anywhere else.
 */
export type RecallGapTrigger =
  'search' | 'memory-tool' | 'failure' | 'turn-end' | 'none';

const TRIGGERS: Record<string, RecallGapTrigger> = {
  pretooluse: 'search',
  posttooluse: 'memory-tool',
  posttoolusefailure: 'failure',
  stop: 'turn-end',
};

/**
 * Classifies a client's event name.
 *
 * Compared by exact (lowercased) name rather than by prefix on purpose: the
 * failure event's name CONTAINS the success event's name, so prefix matching
 * would silently file every failure as a successful tool call and the reminder
 * would never fire.
 */
export const recallGapTrigger = (event: string): RecallGapTrigger =>
  TRIGGERS[event.toLowerCase()] ?? 'none';

/** Which counter a memory-tool call increments, if any. */
export type RecallGapTally = 'recall' | 'remember' | null;

/**
 * Classifies a memory tool call for counting.
 *
 * Uses the shared tool-name helper rather than matching a literal prefix,
 * because the prefix is a per-client mount artifact: one client records
 * `mcp__zero-memory__recall`, another the bare `recall`, and a bundled server a
 * third form. Matching the prefix is how a counter silently reads zero on a
 * client that spells it differently — and a zero read count makes every reminder
 * fire unconditionally, turning the gate inside out.
 */
export const recallGapTally = (
  toolName: string | undefined
): RecallGapTally => {
  if (toolName === undefined || toolName === '') return null;
  const base = toolBaseName(toolName);
  if (base === 'recall' || base === 'build_context') return 'recall';
  if (base === 'remember') return 'remember';
  return null;
};

export const SURPRISE_REMINDER =
  'zero-memory: that just failed and this session has not read memory once. On ' +
  'a surprise — an error, a failing test, unexpected output — recall(<the ' +
  'symptom>) BEFORE debugging by hand: gotchas are stored the moment they are ' +
  'discovered, so the one biting you is likely already written down. Recall ' +
  'first, then investigate.';

export const SEARCH_REMINDER =
  'zero-memory: before deriving an answer from this search, recall(<this exact ' +
  'question>) first — a stored decision, gotcha, or convention may already ' +
  'answer it. Recall, then grep.';

/**
 * Framed as what memory can still offer, never as a reprimand. The count is the
 * user's own writing, and the point is that some of it may already exist.
 */
export const turnEndReminder = (remembers: number): string =>
  `zero-memory: this session has written ${remembers} ` +
  `${remembers === 1 ? 'memory' : 'memories'} and read none. Before storing ` +
  'something as new, recall it first — memory may already hold it, and a second ' +
  'copy of a fact is worse than the original. Recall before you remember.';

export type RecallGapAction =
  | { readonly kind: 'silent' }
  | { readonly kind: 'count'; readonly tally: Exclude<RecallGapTally, null> }
  | {
      readonly kind: 'remind';
      readonly trigger: Extract<
        RecallGapTrigger,
        'search' | 'failure' | 'turn-end'
      >;
      readonly text: string;
    };

export interface RecallGapInput {
  readonly event: string;
  readonly counters: RecallGapCounters;
  /** The tool that succeeded or failed, where the event carries one. */
  readonly toolName?: string;
  /**
   * The client's own signal that it has already been continued once this turn.
   * Honored so a reminder can never drive a continuation loop.
   */
  readonly alreadyContinued?: boolean;
}

/** The one decision: count, remind, or stay quiet. */
export const decideRecallGap = ({
  event,
  counters,
  toolName,
  alreadyContinued,
}: RecallGapInput): RecallGapAction => {
  const trigger = recallGapTrigger(event);

  if (trigger === 'memory-tool') {
    const tally = recallGapTally(toolName);
    return tally === null ? { kind: 'silent' } : { kind: 'count', tally };
  }

  // Reading memory even once retires every reminder for the rest of the session.
  if (counters.recalls > 0) return { kind: 'silent' };

  if (trigger === 'failure') {
    return counters.remindedOnFailure
      ? { kind: 'silent' }
      : { kind: 'remind', trigger: 'failure', text: SURPRISE_REMINDER };
  }

  if (trigger === 'search') {
    return counters.remindedOnSearch
      ? { kind: 'silent' }
      : { kind: 'remind', trigger: 'search', text: SEARCH_REMINDER };
  }

  if (trigger === 'turn-end') {
    if (alreadyContinued === true) return { kind: 'silent' };
    // Nothing written means nothing was rediscovered — there is no gap to name.
    if (counters.remembers === 0 || counters.remindedOnTurnEnd) {
      return { kind: 'silent' };
    }
    return {
      kind: 'remind',
      trigger: 'turn-end',
      text: turnEndReminder(counters.remembers),
    };
  }

  return { kind: 'silent' };
};
