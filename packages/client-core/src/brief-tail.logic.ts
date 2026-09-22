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
 * This module only plans one chunk at a time. It holds no state of its own —
 * two later tasks store the `BriefTail` in the session and call
 * `planTailChunk` from the watcher's per-message hook, trimming `remaining`
 * back into the stored queue after each call.
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
 * Plans one chunk of the tail queue.
 *
 * Which memory goes next: whichever of `preferIds` is still queued — the
 * current message's own topic, ranked ahead of arrival order — or otherwise
 * the head of the queue. `preferIds` is not required to hit: a message about
 * something else still drains the queue in order rather than sending
 * nothing.
 *
 * A memory too large to fit even THIS message's budget still leaves the
 * queue, as a stub instead of a whole delivery. Holding it in place until a
 * larger budget comes along would stall every memory behind it on one that
 * may never fit — worse than naming it and moving on, since the stub is
 * still a pointer the agent can pull by id.
 *
 * Returns null when the queue is already empty — the caller's signal to stop
 * calling and clear the stored tail.
 */
export const planTailChunk = (
  tail: BriefTail,
  budgetChars: number,
  preferIds: readonly string[] = []
): TailChunk | null => {
  if (tail.memories.length === 0) return null;

  const preferred = preferIds
    .map((id) => tail.memories.find((memory) => memory.id === id))
    .find((memory): memory is ContextMemory => memory !== undefined);
  const next = preferred ?? tail.memories[0]!;
  const remaining = tail.memories.filter((memory) => memory.id !== next.id);

  const frame =
    `Continuing the session briefing for "${tail.topic}" — 1 of ` +
    `${tail.memories.length} memory/memories the window has not seen yet ` +
    `(snapshot taken ${tail.takenAt}):`;

  const whole = `${frame}\n${JSON.stringify(next)}`;
  if (whole.length <= budgetChars) {
    return { text: whole, deliveredIds: [next.id], remaining };
  }

  return {
    text: `${frame}\n${renderMemoryStub(next)}`,
    deliveredIds: [],
    remaining,
  };
};
