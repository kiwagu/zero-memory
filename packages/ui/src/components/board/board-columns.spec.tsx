import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import {
  BoardColumns,
  type BoardColumn,
} from '@workspace/ui/components/board/board-columns';

const tile = (n: number) => ({
  id: `crd_${n}`,
  href: `/board/crd_${n}`,
  numberLabel: `ZM-${n}`,
  title: `Card ${n}`,
  badges: [],
});

const HINTS = {
  show: '2 untouched for 30+ days. Show them',
  hide: 'Hide the 2 untouched for 30+ days',
};

const columns: BoardColumn[] = [
  {
    key: 'active',
    label: 'Active',
    cards: [tile(31)],
    older: [tile(3), tile(4)],
    olderHints: HINTS,
  },
  { key: 'waiting', label: 'Waiting', cards: [tile(30)] },
];

describe('BoardColumns', () => {
  it("folds a column's cards past the horizon behind an arrow that says so", () => {
    const html = renderToStaticMarkup(
      <BoardColumns columns={columns} emptyLabel="none" />
    );
    expect(html).toContain('ZM-31');
    // Folded: the old cards are not on screen until the arrow opens them.
    expect(html).not.toContain('ZM-3<');
    expect(html).not.toContain('ZM-4<');
    const toggles = html.match(/data-testid="board-column-older-toggle"/g);
    expect(toggles).toHaveLength(1);
    expect(html).toContain(`aria-label="${HINTS.show}"`);
    expect(html).toContain('aria-expanded="false"');
  });

  it('shows no arrow on a column with nothing past the horizon', () => {
    const html = renderToStaticMarkup(
      <BoardColumns columns={[columns[1]!]} emptyLabel="none" />
    );
    expect(html).toContain('ZM-30');
    expect(html).not.toContain('board-column-older-toggle');
  });

  it('is not an empty board when every card is past the horizon', () => {
    const html = renderToStaticMarkup(
      <BoardColumns
        columns={[
          {
            key: 'done',
            label: 'Done',
            cards: [],
            older: [tile(2)],
            olderHints: HINTS,
          },
        ]}
        emptyLabel="none"
      />
    );
    expect(html).not.toContain('board-empty');
    expect(html).toContain('board-column-older-toggle');
  });
});
