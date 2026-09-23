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
});
