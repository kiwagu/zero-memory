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
      '- This conversation is bound to #3 "Wire the importer" [active]: the importer blocks the release (2 attached'
    );
    expect(block).toContain(
      '- On the board: 1 active · 1 waiting — #4 "Retire the old parser" [waiting]'
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
    expect(block).toContain('2 active · 0 waiting — #5 "One" [active], #6');
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

  it('renders nothing when the summary names no work', () => {
    expect(
      renderBoardSummary({ bound_card: null, active: 0, waiting: 0, lead: [] })
    ).toBeNull();
  });
});
