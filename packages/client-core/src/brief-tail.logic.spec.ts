import { contextMemorySchema } from '@workspace/contracts';
import { describe, expect, it } from 'vitest';

import { planTailChunk, type BriefTail } from './brief-tail.logic.js';

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

  it('prefers what the current message is about', () => {
    const chunk = planTailChunk(tail(memory(1), memory(2)), 9_000, [
      memory(2).id,
    ]);
    expect(chunk?.deliveredIds).toEqual([memory(2).id]);
    // Pins which memory stays queued: the NON-preferred one, not the one
    // just delivered. A naive `slice(1)` instead of filtering by id would
    // drop memory(1) from the queue entirely and leave memory(2) — the
    // delivered one — still queued for re-delivery next message.
    expect(chunk?.remaining.map((memory) => memory.id)).toEqual([memory(1).id]);
  });

  it('falls back to a stub when the memory itself does not fit', () => {
    const chunk = planTailChunk(tail(memory(1, 20_000)), 400);
    expect(chunk?.deliveredIds).toEqual([]);
    expect(chunk?.text).toContain(memory(1).id);
    expect(chunk?.remaining).toEqual([]);
  });

  it('has nothing to send for an empty tail', () => {
    expect(planTailChunk(tail(), 9_000)).toBeNull();
  });
});
