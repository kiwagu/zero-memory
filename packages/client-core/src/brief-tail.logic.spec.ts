import { contextMemorySchema } from '@workspace/contracts';
import { describe, expect, it } from 'vitest';

import {
  mergeBriefTail,
  planTailChunk,
  type BriefTail,
} from './brief-tail.logic.js';

// Built through the contract, the same way the sibling brief-budget spec
// does it: a hand-rolled literal would let an id shape the real pack can
// never contain into the fixtures.
const memory = (n: number, size = 100) =>
  contextMemorySchema.parse({
    id: `mem_${String(n).padStart(16, '0')}.0000000000`,
    kind: 'fact',
    content: 'x'.repeat(size),
    scope: 'proj.x',
    created_at: '2026-09-22T00:00:00Z',
  });

const tail = (...memories: ReturnType<typeof memory>[]): BriefTail => ({
  topic: 'a project',
  memories,
  takenAt: '2026-09-22T10:00:00Z',
});

describe('planTailChunk', () => {
  it('delivers one memory per call and keeps the rest', () => {
    const chunk = planTailChunk(tail(memory(1), memory(2)), 9_000);
    expect(chunk?.deliveredIds).toEqual([memory(1).id]);
    expect(chunk?.remaining.map((m) => m.id)).toEqual([memory(2).id]);
  });

  it('frames the chunk with what it is and how much is left', () => {
    const chunk = planTailChunk(tail(memory(1), memory(2)), 9_000);
    expect(chunk?.text).toContain('1 of 2');
    expect(chunk?.text).toContain('session briefing');
  });

  it('says the chunk is a snapshot taken when the window opened', () => {
    const chunk = planTailChunk(tail(memory(1)), 9_000);
    expect(chunk?.text).toContain('2026-09-22T10:00:00Z');
  });

  it('falls back to a stub when the memory itself does not fit', () => {
    const chunk = planTailChunk(tail(memory(1, 20_000)), 400);
    expect(chunk?.deliveredIds).toEqual([]);
    expect(chunk?.text).toContain(memory(1).id);
    expect(chunk?.remaining).toEqual([]);
  });

  it('sends nothing and keeps the whole queue when not even a stub fits', () => {
    // A message whose own lead leaves the chunk less room than the frame:
    // sending past the budget spills the whole message, and dropping the
    // memory unsent loses it — so the queue simply waits.
    const chunk = planTailChunk(tail(memory(1, 20_000), memory(2)), 100);
    expect(chunk?.text).toBe('');
    expect(chunk?.deliveredIds).toEqual([]);
    expect(chunk?.remaining.map((m) => m.id)).toEqual([
      memory(1).id,
      memory(2).id,
    ]);
  });

  it('never returns a chunk longer than its budget', () => {
    const queue = tail(memory(1, 2_000), memory(2));
    for (let budget = 0; budget <= 2_400; budget += 1) {
      expect(planTailChunk(queue, budget)?.text.length).toBeLessThanOrEqual(
        budget
      );
    }
  });

  it('has nothing to send for an empty tail', () => {
    expect(planTailChunk(tail(), 9_000)).toBeNull();
  });
});

describe('mergeBriefTail', () => {
  it('drops from the queue what a briefing just delivered whole', () => {
    const merged = mergeBriefTail(
      [memory(1), memory(2), memory(3)],
      [memory(2).id],
      []
    );
    expect(merged.map((m) => m.id)).toEqual([memory(1).id, memory(3).id]);
  });

  it("queues a briefing's leftovers after what was already waiting", () => {
    const merged = mergeBriefTail(
      [memory(1), memory(2)],
      [],
      [memory(3), memory(4)]
    );
    expect(merged.map((m) => m.id)).toEqual([
      memory(1).id,
      memory(2).id,
      memory(3).id,
      memory(4).id,
    ]);
  });

  it('queues a memory left over twice only once, where it already stood', () => {
    const merged = mergeBriefTail(
      [memory(1), memory(2)],
      [],
      [memory(3), memory(1), memory(3)]
    );
    expect(merged.map((m) => m.id)).toEqual([
      memory(1).id,
      memory(2).id,
      memory(3).id,
    ]);
  });

  it('never re-queues a leftover the same briefing delivered whole', () => {
    // A pack can carry one memory in two legs (a ranked hit that is also
    // recent): the copy that arrived whole settles it.
    const merged = mergeBriefTail([], [memory(1).id], [memory(1), memory(2)]);
    expect(merged.map((m) => m.id)).toEqual([memory(2).id]);
  });
});
