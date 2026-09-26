import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { BoardCardList } from '@workspace/ui/components/board/board-card-list';

const tile = (n: number) => ({
  id: `crd_${n}`,
  href: `/board/crd_${n}`,
  numberLabel: `ZM-${n}`,
  title: `Card ${n}`,
  badges: [],
});

describe('BoardCardList', () => {
  it('keeps the order it is given, newest own work first', () => {
    const html = renderToStaticMarkup(
      <BoardCardList cards={[tile(31), tile(29), tile(3)]} emptyLabel="none" />
    );
    expect(html.indexOf('ZM-31')).toBeLessThan(html.indexOf('ZM-29'));
    expect(html.indexOf('ZM-29')).toBeLessThan(html.indexOf('ZM-3<'));
    expect(html).toContain('data-testid="board-mine-list"');
  });

  it('says so when there is nothing of mine', () => {
    const html = renderToStaticMarkup(
      <BoardCardList
        cards={[]}
        emptyLabel="You have not worked on any card here yet."
      />
    );
    expect(html).toContain('data-testid="board-mine-empty"');
    expect(html).toContain('You have not worked on any card here yet.');
  });
});
