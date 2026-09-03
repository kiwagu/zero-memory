import type { ContextMemory } from '@workspace/contracts';
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_ANCHOR_BUDGET_CHARS,
  renderCompactionAnchor,
} from './compaction-anchor.logic.js';

const NOW = new Date('2026-08-16T20:00:00.000Z');

const loop = (id: string, content: string, createdAt: string): ContextMemory =>
  ({
    id,
    content,
    kind: 'task',
    scope: 'proj.acme',
    created_at: createdAt,
  }) as ContextMemory;

describe('renderCompactionAnchor', () => {
  it('addresses the summarizer, because that is who receives it', () => {
    // The measured delivery is "additional instructions to the model writing
    // the summary" — not a block prepended to the surviving context. Text that
    // does not ask for preservation is only preserved by luck.
    const anchor = renderCompactionAnchor(
      {
        scope: 'proj.acme',
        thread: 'thr_abc.01',
        loops: [loop('mem_a.01', 'ship the migration', '2026-08-14T00:00:00Z')],
        total: 1,
      },
      NOW
    );

    expect(anchor).toContain('preserve the block below in the summary');
    expect(anchor).toContain('PROJECT: proj.acme · THREAD: thr_abc.01');
    expect(anchor).toContain('ship the migration');
  });

  it('keeps the loops as recorded data rather than as orders', () => {
    // Same hygiene the briefing holds to: the agent decides what to act on, so
    // the only imperative in the anchor is about summary fidelity.
    const anchor = renderCompactionAnchor(
      {
        scope: null,
        thread: null,
        loops: [loop('mem_a.01', 'ship the migration', '2026-08-14T00:00:00Z')],
        total: 1,
      },
      NOW
    );

    expect(anchor).toContain('Open loops recorded in persistent memory');
  });

  it('says nothing when it has nothing to anchor', () => {
    // An anchor that only announces its own emptiness still costs a read.
    expect(
      renderCompactionAnchor(
        { scope: null, thread: null, loops: [], total: 0 },
        NOW
      )
    ).toBeNull();
  });

  it('still anchors identity when no loop is open', () => {
    const anchor = renderCompactionAnchor(
      { scope: 'proj.acme', thread: 'thr_abc.01', loops: [], total: 0 },
      NOW
    );

    expect(anchor).toContain('PROJECT: proj.acme');
    expect(anchor).not.toContain('Open loops recorded');
  });

  it('stays inside its budget and counts what it dropped', () => {
    // The budget protects the SESSION's share of the summarizer's attention:
    // an anchor that crowds out the conversation defeats its own purpose. A
    // dropped loop must still be counted, never silently gone.
    const many = Array.from({ length: 40 }, (_, i) =>
      loop(
        `mem_${i}.01`,
        `loop ${i} — ${'detail '.repeat(20)}`,
        '2026-08-14T00:00:00Z'
      )
    );

    const anchor = renderCompactionAnchor(
      { scope: 'proj.acme', thread: 'thr_abc.01', loops: many, total: 40 },
      NOW
    );

    expect(anchor).not.toBeNull();
    expect(anchor!.length).toBeLessThanOrEqual(DEFAULT_ANCHOR_BUDGET_CHARS);
    expect(anchor).toContain('more active open loops');
  });
});
