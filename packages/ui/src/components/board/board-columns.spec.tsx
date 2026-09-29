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

  it('draws the severity meter under the label of a tile that carries one, before its title', () => {
    const html = renderToStaticMarkup(
      <BoardColumns
        columns={[
          {
            key: 'active',
            label: 'Active',
            cards: [
              {
                ...tile(44),
                severity: { level: 5, hint: 'Severity 5 of 5: urgent' },
              },
            ],
          },
        ]}
        emptyLabel="none"
      />
    );
    const meter = html.indexOf('data-testid="card-severity"');
    expect(meter).toBeGreaterThan(html.indexOf('ZM-44'));
    expect(meter).toBeLessThan(html.indexOf('Card 44'));
    expect(html).toContain('data-severity="5"');
  });

  it('keeps a three-digit label on one line, with the meter spanning the label column', () => {
    const html = renderToStaticMarkup(
      <BoardColumns
        columns={[
          {
            key: 'idea',
            label: 'Idea',
            cards: [
              {
                ...tile(111),
                title: 'A title long enough to wrap beside the label column',
                severity: { level: 2, hint: 'Severity 2 of 5: low' },
              },
            ],
          },
        ]}
        emptyLabel="none"
      />
    );
    // The label never wraps, whatever its digit count: `ZM-111` split after
    // its hyphen would read as two things.
    const label = html.match(/<span[^>]*data-testid="board-card-number"[^>]*>/);
    expect(label?.[0]).toContain('whitespace-nowrap');
    expect(html).toContain('>ZM-111<');
    // The meter is as wide as the label column, not a fixed few pixels.
    const meter = html.match(/<span[^>]*data-testid="card-severity"[^>]*>/);
    expect(meter?.[0]).toContain('w-full');
  });
});
