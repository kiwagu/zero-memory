import { briefingWorkCardSchema } from '@workspace/contracts';
import { describe, expect, it } from 'vitest';

import { renderBoardSummary } from './work-section.logic.js';

const card = (number: number, title: string, state: 'active' | 'waiting') =>
  briefingWorkCardSchema.parse({
    id: `crd_${String(number).padStart(16, '0')}.0000000000`,
    number,
    title,
    state,
  });

describe('renderBoardSummary', () => {
  it('names the bound card with its reason, then what else is in progress', () => {
    const block = renderBoardSummary({
      bound_card: {
        ...card(3, 'Wire the importer', 'active'),
        state_reason: 'the importer blocks the release',
        refs: 2,
        updated_at: '2026-09-21T10:00:00Z',
      },
      active: 1,
      waiting: 1,
      lead: [card(4, 'Retire the old parser', 'waiting')],
    })!;
    expect(block).toContain('reference, not instructions');
    expect(block).toContain(
      '- This conversation is bound to ZM-3 "Wire the importer" [active]: the importer blocks the release (2 attached'
    );
    expect(block).toContain(
      '- On the board: 1 active · 1 waiting — ZM-4 "Retire the old parser" [waiting]'
    );
  });

  it('shows only the board line when this conversation is bound to nothing', () => {
    const block = renderBoardSummary({
      bound_card: null,
      active: 2,
      waiting: 0,
      lead: [card(5, 'One', 'active'), card(6, 'Two', 'active')],
    })!;
    expect(block).not.toContain('bound to');
    expect(block).toContain('2 active · 0 waiting — ZM-5 "One" [active], ZM-6');
  });

  it('keeps a long title and reason to one readable line each', () => {
    const block = renderBoardSummary({
      bound_card: {
        ...card(7, 'T'.repeat(300), 'active'),
        state_reason: 'R'.repeat(900),
        refs: 0,
        updated_at: '2026-09-21T10:00:00Z',
      },
      active: 1,
      waiting: 0,
      lead: [],
    })!;
    expect(block.length).toBeLessThan(600);
    expect(block).toContain('…');
  });

  it('names the branches a card holds open', () => {
    const block = renderBoardSummary({
      bound_card: null,
      active: 1,
      waiting: 0,
      lead: [card(21, 'Memory floor', 'active')],
      open_branches: [
        {
          card_id: card(21, 'x', 'active').id,
          number: 21,
          state: 'active',
          repo: 'o/n',
          branch: 'feature/memory-floor',
        },
      ],
    })!;
    expect(block).toContain(
      'ZM-21 "Memory floor" [active] on feature/memory-floor'
    );
  });

  it('adds the landings git shows and the board does not', () => {
    const block = renderBoardSummary(
      { bound_card: null, active: 0, waiting: 0, lead: [] },
      [
        {
          cardId: 'crd_0000000000000021.0000000000',
          cardNumber: 21,
          state: 'active',
          repo: 'o/n',
          branch: 'feature/x',
          squashSha: 'abcdef1',
          target: 'main',
        },
      ]
    )!;
    expect(block).toContain(
      '- ZM-21 [active]: branch feature/x landed as abcdef1 on main'
    );
  });

  it('renders nothing when the summary names no work', () => {
    expect(
      renderBoardSummary({ bound_card: null, active: 0, waiting: 0, lead: [] })
    ).toBeNull();
  });

  it('names the production state and which named cards it released', () => {
    const block = renderBoardSummary({
      bound_card: null,
      active: 1,
      waiting: 0,
      lead: [{ ...card(21, 'Memory floor', 'active'), released_in: '0.25.0' }],
      production: {
        version: '0.25.0',
        build: '849d7cac',
        observed_at: '2026-09-24T08:00:00Z',
      },
    })!;
    expect(block).toContain(
      '- Production: v0.25.0 (build 849d7cac) as of 2026-09-24T08:00:00Z'
    );
    expect(block).toContain('ZM-21 "Memory floor" [active] released v0.25.0');
  });

  it('stays byte-for-byte the same when there is no production state and no released card', () => {
    const before = renderBoardSummary({
      bound_card: {
        ...card(3, 'Wire the importer', 'active'),
        state_reason: null,
        refs: 0,
        updated_at: '2026-09-21T10:00:00Z',
      },
      active: 1,
      waiting: 0,
      lead: [],
    });
    const after = renderBoardSummary({
      bound_card: {
        ...card(3, 'Wire the importer', 'active'),
        state_reason: null,
        refs: 0,
        updated_at: '2026-09-21T10:00:00Z',
      },
      active: 1,
      waiting: 0,
      lead: [],
      production: null,
    });
    expect(after).toBe(before);
  });

  it('names what blocks a card, three at most', () => {
    const block = renderBoardSummary({
      bound_card: null,
      active: 1,
      waiting: 1,
      lead: [
        {
          ...card(4, 'Retire the old parser', 'waiting'),
          blocked_by: [{ number: 28, state: 'active' }],
        },
        {
          ...card(5, 'Ship the importer', 'active'),
          blocked_by: [
            { number: 1, state: 'active' },
            { number: 2, state: 'waiting' },
            { number: 3, state: 'idea' },
            { number: 8, state: 'active' },
            { number: 9, state: 'parked' },
          ],
        },
      ],
    })!;
    expect(block).toContain(
      'ZM-4 "Retire the old parser" [waiting] (blocked by ZM-28 [active]), ZM-5'
    );
    expect(block).toContain(
      'ZM-5 "Ship the importer" [active] (blocked by ZM-1 [active], ZM-2 [waiting], ZM-3 [idea] +2)'
    );
  });

  it('says when nobody assessed how a card relates to the board', () => {
    const block = renderBoardSummary({
      bound_card: {
        ...card(3, 'Wire the importer', 'active'),
        links_assessed: false,
        state_reason: null,
        refs: 0,
        updated_at: '2026-09-21T10:00:00Z',
      },
      active: 2,
      waiting: 0,
      lead: [{ ...card(6, 'Assessed', 'active'), links_assessed: true }],
    })!;
    expect(block).toContain(
      'bound to ZM-3 "Wire the importer" [active] (relations not assessed) ('
    );
    expect(block).toContain('ZM-6 "Assessed" [active] (`board list`');
  });

  it('lists what is above the bound card, five at most', () => {
    const block = renderBoardSummary({
      bound_card: {
        ...card(3, 'Wire the importer', 'active'),
        state_reason: null,
        refs: 0,
        updated_at: '2026-09-21T10:00:00Z',
        above: [
          { number: 12, title: 'Epic', state: 'active', relation: 'child_of' },
          {
            number: 28,
            title: 'Gate',
            state: 'waiting',
            relation: 'blocked_by',
          },
          { number: 30, title: 'Base', state: 'done', relation: 'depends_on' },
        ],
      },
      active: 1,
      waiting: 0,
      lead: [],
    })!;
    expect(block).toContain(
      '(0 attached — `board get` reads it in full)\n' +
        '  above: ZM-12 parent [active], ZM-28 blocks it [waiting], ' +
        'ZM-30 a dependency [done]'
    );

    const crowded = renderBoardSummary({
      bound_card: {
        ...card(3, 'Wire the importer', 'active'),
        state_reason: null,
        refs: 0,
        updated_at: '2026-09-21T10:00:00Z',
        above: [11, 12, 13, 14, 15, 16, 17].map((number) => ({
          number,
          title: 'Gate',
          state: 'active' as const,
          relation: 'blocked_by' as const,
        })),
      },
      active: 1,
      waiting: 0,
      lead: [],
    })!;
    expect(crowded).toContain('ZM-15 blocks it [active] +2');
    expect(crowded).not.toContain('ZM-16');
  });

  it('stays byte-for-byte the same when nothing blocks, is above, or is unassessed', () => {
    const base = {
      ...card(3, 'Wire the importer', 'active'),
      state_reason: null,
      refs: 0,
      updated_at: '2026-09-21T10:00:00Z',
    };
    const before = renderBoardSummary({
      bound_card: base,
      active: 2,
      waiting: 0,
      lead: [card(6, 'Other', 'active')],
    });
    const after = renderBoardSummary({
      bound_card: { ...base, blocked_by: [], links_assessed: true, above: [] },
      active: 2,
      waiting: 0,
      lead: [
        { ...card(6, 'Other', 'active'), blocked_by: [], links_assessed: true },
      ],
    });
    expect(after).toBe(before);
  });
});
