import {
  briefingWorkCardSchema,
  type BriefingWork,
} from '@workspace/contracts';
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

  it('names the board of a blocker or a card above that lives on another one, and marks an archived one', () => {
    const block = renderBoardSummary({
      bound_card: {
        ...card(3, 'Wire the importer', 'active'),
        state_reason: null,
        refs: 0,
        updated_at: '2026-09-21T10:00:00Z',
        blocked_by: [
          { number: 3, state: 'active', scope: 'proj.usr_ab12_01k.acme' },
        ],
        above: [
          {
            number: 12,
            title: 'Epic',
            state: 'done',
            relation: 'child_of',
            archived: true,
            scope: null,
          },
          {
            number: 3,
            title: 'Gate',
            state: 'active',
            relation: 'blocked_by',
            archived: false,
            scope: 'proj.usr_ab12_01k.acme',
          },
        ],
      },
      active: 1,
      waiting: 0,
      lead: [],
    })!;
    expect(block).toContain('(blocked by ZM-3 [active] on acme)');
    expect(block).toContain(
      '  above: ZM-12 parent [done, archived], ZM-3 blocks it [active] on acme'
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

  const continuing = (
    over: Partial<NonNullable<BriefingWork['continuation']>> = {}
  ): NonNullable<BriefingWork['continuation']> => ({
    card: {
      ...card(30, 'A new session sees what it left off', 'active'),
      state_reason: "Picked up on the owner's word",
    },
    last: [
      {
        type: 'noted',
        from_state: null,
        to_state: null,
        text: 'Recorded: the offer lives in the bound-card slot',
        created_at: '2026-09-25T17:58:12.123456+00:00',
      },
      {
        type: 'moved',
        from_state: 'idea',
        to_state: 'active',
        text: 'Picked up',
        created_at: '2026-09-25T17:56:43+00:00',
      },
    ],
    last_session: null,
    thread: 'thr_0000000000000001.0000000000',
    ...over,
  });

  it('says where you left off and how to pick it up, when this conversation is bound to none', () => {
    const block = renderBoardSummary({
      bound_card: null,
      active: 1,
      waiting: 0,
      lead: [],
      open_branches: [
        {
          card_id: continuing().card!.id,
          number: 30,
          state: 'active',
          repo: 'acme/relay',
          branch: 'feature/session-continuation',
        },
      ],
      continuation: continuing(),
    })!;
    expect(block).toContain(
      '- Continue where you left off: ZM-30 "A new session sees what it left off" ' +
        "[active] on feature/session-continuation: Picked up on the owner's word"
    );
    expect(block).toContain(
      '  last: noted 2026-09-25 17:58 "Recorded: the offer lives in the bound-card slot"; ' +
        'moved to active 2026-09-25 17:56 "Picked up"'
    );
    expect(block).toContain(
      '  to continue it here: card_log attach {card_id: crd_0000000000000030.0000000000, ' +
        'ref_kind: thread, ref_target: thr_0000000000000001.0000000000}'
    );
    expect(block).not.toContain('Last session');
  });

  it('names the last step when it was on another card, and alone when nothing is active', () => {
    const both = renderBoardSummary({
      bound_card: null,
      active: 1,
      waiting: 1,
      lead: [],
      continuation: continuing({
        last_session: {
          number: 29,
          title: 'Relations',
          type: 'moved',
          to_state: 'waiting',
        },
      }),
    })!;
    expect(both).toContain('- Last session: ZM-29 moved to waiting');
    const alone = renderBoardSummary({
      bound_card: null,
      active: 0,
      waiting: 1,
      lead: [],
      continuation: continuing({
        card: null,
        last: [],
        last_session: {
          number: 29,
          title: 'Relations',
          type: 'noted',
          to_state: null,
        },
      }),
    })!;
    expect(alone).not.toContain('Continue where');
    expect(alone).toContain('- Last session: ZM-29 noted');
  });

  it("keeps the offer's text to one clipped line", () => {
    const block = renderBoardSummary({
      bound_card: null,
      active: 1,
      waiting: 0,
      lead: [],
      continuation: continuing({
        last: [
          {
            type: 'noted',
            from_state: null,
            to_state: null,
            text: `line one\nline two ${'y'.repeat(300)}`,
            created_at: '2026-09-25T17:58:12+00:00',
          },
        ],
      }),
    })!;
    const last = block.split('\n').find((line) => line.startsWith('  last:'))!;
    expect(last).toContain('"line one line two ');
    expect(last.endsWith('…"')).toBe(true);
    expect(last.length).toBeLessThan(170);
  });

  it('a bound conversation shows its bound card, never an offer', () => {
    const block = renderBoardSummary({
      bound_card: {
        ...card(3, 'Wire the importer', 'active'),
        state_reason: null,
        refs: 0,
        updated_at: '2026-09-21T10:00:00Z',
      },
      active: 1,
      waiting: 0,
      lead: [],
      continuation: continuing(),
    })!;
    expect(block).not.toContain('Continue where');
    expect(block).not.toContain('Last session');
  });
});
