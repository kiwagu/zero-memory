import { describe, expect, it } from 'vitest';

import {
  filterBriefingPack,
  isEmptyPack,
  isSubstantivePrompt,
  packMemoryIds,
  parseBriefingPack,
  resolveAcknowledgementWords,
} from './task-brief.logic.js';

const memId = (n: number): string =>
  `mem_${String(n).padStart(16, '0')}.0000000000`;

const memory = (id: string) => ({
  id,
  content: 'stored fact',
  kind: 'fact',
  scope: 'proj.alpha',
  created_at: '2026-07-13T00:00:00Z',
  score: 0.03,
});

const loop = (id: string) => ({
  ...memory(id),
  kind: 'task',
});

const pack = (
  ids: string[],
  linkedIds: string[] = [],
  loopIds: string[] = []
) =>
  parseBriefingPack({
    memories: ids.map(memory),
    entities: [],
    edges: [],
    linked_memories: linkedIds.map(memory),
    open_loops: loopIds.map(loop),
    open_loops_total: loopIds.length,
  });

describe('isSubstantivePrompt', () => {
  it('accepts a real task prompt', () => {
    expect(
      isSubstantivePrompt(
        'implement the task-aware briefing hook from the plan'
      )
    ).toBe(true);
    expect(
      isSubstantivePrompt(
        'fix the dashboard search, it drops non-latin queries'
      )
    ).toBe(true);
  });

  it('rejects short prompts, confirmations, and slash commands', () => {
    expect(isSubstantivePrompt('ok')).toBe(false);
    expect(isSubstantivePrompt('continue')).toBe(false);
    expect(isSubstantivePrompt('  go on  ')).toBe(false);
    expect(isSubstantivePrompt('/compact keep the current test plan')).toBe(
      false
    );
    expect(isSubstantivePrompt('')).toBe(false);
  });

  it('rejects long strings made only of acknowledgement words', () => {
    expect(
      isSubstantivePrompt('yes, ok, okay, sure, fine, go, continue, thanks!')
    ).toBe(false);
  });

  it('skips configured extra acknowledgements (no language bias in the defaults)', () => {
    // A non-English run of confirmations is task signal by default...
    const foreignRunOn = 'aye aye, richtig, weiter, danke sehr vielmals gut!';
    expect(isSubstantivePrompt(foreignRunOn)).toBe(true);
    // ...until the operator supplies those words via config (ZM_ACK_WORDS).
    const acks = resolveAcknowledgementWords(
      'aye richtig weiter danke sehr vielmals gut'
    );
    expect(isSubstantivePrompt(foreignRunOn, acks)).toBe(false);
    // A real task prompt stays substantive even with extras configured.
    expect(
      isSubstantivePrompt(
        'fix the dashboard search bug that was reported',
        acks
      )
    ).toBe(true);
  });
});

describe('filterBriefingPack', () => {
  it('drops already-injected memories from both memory lists', () => {
    const filtered = filterBriefingPack(
      pack([memId(1), memId(2)], [memId(3)]),
      [memId(1), memId(3)]
    );
    expect(filtered.memories.map((m) => m.id)).toEqual([memId(2)]);
    expect(filtered.linked_memories).toHaveLength(0);
  });

  it('reports emptiness only when all lists are drained', () => {
    expect(isEmptyPack(filterBriefingPack(pack([memId(1)]), [memId(1)]))).toBe(
      true
    );
    expect(isEmptyPack(filterBriefingPack(pack([memId(1)]), []))).toBe(false);
    expect(isEmptyPack(filterBriefingPack(pack([], [], [memId(4)]), []))).toBe(
      false
    );
  });

  it('drops already-shown open loops and shrinks the total with them', () => {
    const filtered = filterBriefingPack(pack([], [], [memId(4), memId(5)]), [
      memId(4),
    ]);
    expect(filtered.open_loops.map((m) => m.id)).toEqual([memId(5)]);
    expect(filtered.open_loops_total).toBe(1);
  });

  it('parses an older-server pack without open-loop fields', () => {
    const parsed = parseBriefingPack({
      memories: [memory(memId(1))],
      entities: [],
      edges: [],
      linked_memories: [],
    });
    expect(parsed.open_loops).toEqual([]);
    expect(parsed.open_loops_total).toBe(0);
  });
});

describe('packMemoryIds', () => {
  it('collects ids from memories, linked_memories, and open_loops', () => {
    expect(packMemoryIds(pack([memId(1)], [memId(2)], [memId(3)]))).toEqual([
      memId(1),
      memId(2),
      memId(3),
    ]);
  });

  it('never throws on junk payloads', () => {
    expect(packMemoryIds(null)).toEqual([]);
    expect(packMemoryIds({ memories: 'nope' })).toEqual([]);
  });
});
