import type { ContextMemory } from '@workspace/contracts';

import { renderMemoryStub } from './brief-budget.logic.js';

/**
 * The tail queue: what the first briefing of an epoch could not fit.
 *
 * `renderPackWithinBudget` (brief-budget.logic.ts) already names everything
 * that did not fit as a one-line stub, but a stub is a pointer, not a
 * delivery — reaching the memory behind it still means the agent calling
 * `recall` or `build_context` on its own, which is exactly the read-discipline
 * dependence the hooks exist to remove. The tail turns that leftover into a
 * queue instead: one memory rides along with each following message, framed
 * as a continuation of the SAME briefing, until the queue drains.
 *
 * This module holds no state of its own. The session state stores the
 * `BriefTail`; the watcher's per-message hook calls `planTailChunk` on each
 * message that builds no briefing of its own and stores `remaining` back as
 * the queue, and `mergeBriefTail` settles the queue against the one message
 * that does build a briefing.
 *
 * The queue drains in the order it holds, which is the server's own rank at
 * the moment the pack was taken — never by relevance to the current message.
 * There is no such signal to rank by: the prompt deliberately never leaves the
 * machine, and the per-message briefing asks the server about the project,
 * not about the message. Ranking locally against the prompt fails too: the
 * prompt and the stored memories need not share a language, and the watcher
 * has no embedder of its own. The only way left to rank the tail by the
 * message is to ship the prompt off the machine, which is exactly what the
 * hooks are built not to do.
 */
export interface BriefTail {
  readonly topic: string;
  readonly memories: readonly ContextMemory[];
  /**
   * When the pack behind this tail was taken. A chunk says so honestly — it
   * is a snapshot of the window's opening moment, not a fresh read of
   * memory as it stands when the chunk is actually delivered.
   */
  readonly takenAt: string;
}

export interface TailChunk {
  /**
   * The chunk as it goes into the message — never longer than the budget it
   * was planned for. Empty when not even a stub of the head fits, in which
   * case nothing is sent and `remaining` is the whole queue, unchanged.
   */
  readonly text: string;
  /**
   * Ids delivered WHOLE this call. Empty when the memory only reached the
   * queue as a stub — a stub names a memory, it does not deliver it, so
   * there is nothing here for a caller to dedup against a later pack.
   */
  readonly deliveredIds: string[];
  readonly remaining: ContextMemory[];
}

/**
 * Plans one chunk of the tail queue: the memory at its head.
 *
 * A memory too large to fit even THIS message's budget still leaves the
 * queue, as a stub instead of a whole delivery. Holding it in place until a
 * larger budget comes along would stall every memory behind it on one that
 * may never fit — worse than naming it and moving on, since the stub is
 * still a pointer the agent can pull by id.
 *
 * When not even that stub fits, nothing is sent and the queue stays whole —
 * the one case where the head does not leave. A chunk past its budget spills
 * the whole message it rides in, and a head dropped unsent is lost for the
 * window; a queue that waits loses nothing.
 *
 * Returns null when the queue is already empty — the caller's signal to stop
 * calling and clear the stored tail.
 */
export const planTailChunk = (
  tail: BriefTail,
  budgetChars: number
): TailChunk | null => {
  if (tail.memories.length === 0) return null;

  const next = tail.memories[0]!;
  const remaining = tail.memories.filter((memory) => memory.id !== next.id);

  const frame =
    `Continuing the session briefing for "${tail.topic}" — 1 of ` +
    `${tail.memories.length} memory/memories the window has not seen yet ` +
    `(snapshot taken ${tail.takenAt}):`;

  const whole = `${frame}\n${JSON.stringify(next)}`;
  if (whole.length <= budgetChars) {
    return { text: whole, deliveredIds: [next.id], remaining };
  }

  const stub = `${frame}\n${renderMemoryStub(next)}`;
  if (stub.length <= budgetChars) {
    return { text: stub, deliveredIds: [], remaining };
  }

  return { text: '', deliveredIds: [], remaining: [...tail.memories] };
};

/**
 * Settles the queue against a briefing that just rendered a pack of its own:
 * what that pack delivered WHOLE leaves the queue, and what it left over joins
 * it — the queue's own order first, then the new leftovers in the pack's
 * order, each memory once.
 *
 * The overlap is real, not hypothetical. A later briefing leaves out only
 * what an earlier one delivered whole, so a memory the earlier one merely
 * named by stub — and therefore queued — can come back in the later pack.
 * Delivered whole there, it must not arrive a second time from the queue;
 * left over again, it keeps the place it already held rather than moving to
 * the back behind memories that were queued after it.
 */
export const mergeBriefTail = (
  queued: readonly ContextMemory[],
  deliveredIds: readonly string[],
  leftovers: readonly ContextMemory[]
): ContextMemory[] => {
  const seen = new Set(deliveredIds);
  const merged: ContextMemory[] = [];
  for (const memory of [...queued, ...leftovers]) {
    if (seen.has(memory.id)) continue;
    seen.add(memory.id);
    merged.push(memory);
  }
  return merged;
};
