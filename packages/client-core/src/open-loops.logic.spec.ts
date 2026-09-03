import { contextMemorySchema } from '@workspace/contracts';
import { describe, expect, it } from 'vitest';

import {
  mergeOpenLoops,
  renderOpenLoopsSection,
  splitOpenLoops,
} from './open-loops.logic.js';

const memId = (n: number): string =>
  `mem_${String(n).padStart(16, '0')}.0000000000`;

const loop = (n: number, createdAt = '2026-07-10T00:00:00Z') =>
  contextMemorySchema.parse({
    id: memId(n),
    content: `check the watcher log on machine ${n}`,
    kind: 'task',
    scope: 'proj.alpha',
    created_at: createdAt,
  });

const payload = (loops: ReturnType<typeof loop>[], total = loops.length) => ({
  memories: [],
  entities: [],
  edges: [],
  linked_memories: [],
  open_loops: loops,
  open_loops_total: total,
});

describe('splitOpenLoops', () => {
  it('drains the loops out of a briefing payload', () => {
    const split = splitOpenLoops(payload([loop(1)], 3));
    expect(split.loops.map((l) => l.id)).toEqual([memId(1)]);
    expect(split.total).toBe(3);
    expect(split.payload).toMatchObject({
      open_loops: [],
      open_loops_total: 0,
    });
  });

  it('passes a non-pack payload through verbatim (older server)', () => {
    const junk = { anything: true };
    const split = splitOpenLoops(junk);
    expect(split.payload).toBe(junk);
    expect(split.loops).toEqual([]);
    expect(split.total).toBe(0);
  });
});

describe('mergeOpenLoops', () => {
  it('unions loops of overlapping briefings by id, oldest first', () => {
    const a = splitOpenLoops(
      payload([
        loop(1, '2026-07-01T00:00:00Z'),
        loop(2, '2026-07-05T00:00:00Z'),
      ])
    );
    const b = splitOpenLoops(
      payload([
        loop(2, '2026-07-05T00:00:00Z'),
        loop(3, '2026-07-03T00:00:00Z'),
      ])
    );
    const merged = mergeOpenLoops([a, b]);
    expect(merged.loops.map((l) => l.id)).toEqual([
      memId(1),
      memId(3),
      memId(2),
    ]);
    // Totals are scope-wide counts each briefing already reported: max, not sum
    // — but never below the union actually shown.
    expect(merged.total).toBe(3);
  });

  it('handles the no-splits case', () => {
    expect(mergeOpenLoops([])).toEqual({ loops: [], total: 0 });
  });
});

describe('renderOpenLoopsSection', () => {
  const now = new Date('2026-07-13T12:00:00Z');

  it('renders nothing when there are no loops', () => {
    expect(renderOpenLoopsSection([], 0, now)).toBeNull();
  });

  it('renders loops with kind and staleness badge, plus the beyond-cap count', () => {
    const section = renderOpenLoopsSection(
      [loop(1, '2026-07-10T00:00:00Z'), loop(2, '2026-07-13T11:00:00Z')],
      5,
      now
    );
    expect(section).toContain('Open loops recorded in persistent memory');
    expect(section).toContain('(5 active');
    expect(section).toContain(
      `[task, open 3d] check the watcher log on machine 1 (id: ${memId(1)})`
    );
    // A loop younger than a day carries no staleness badge.
    expect(section).toContain(`[task] check the watcher log on machine 2`);
    expect(section).toContain('(+3 more active open loops)');
  });

  it('renders as recorded data, not imperatives', () => {
    const section = renderOpenLoopsSection([loop(1)], 1, now)!;
    expect(section.startsWith('Open loops recorded')).toBe(true);
  });
});
