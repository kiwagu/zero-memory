import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { BoardCardTile } from '@workspace/ui/components/board/board-card-tile';

const card = {
  id: 'crd_3',
  href: '/board/crd_3',
  numberLabel: 'ZM-3',
  title: 'Stale idea',
  badges: [],
};

describe('BoardCardTile', () => {
  it('draws a card that went quiet dimmed, and says so for the reader', () => {
    const html = renderToStaticMarkup(<BoardCardTile card={card} quiet />);
    expect(html).toContain('data-quiet="true"');
    expect(html).toContain('bg-muted/60');
  });

  it('draws a live card as it always was', () => {
    const html = renderToStaticMarkup(<BoardCardTile card={card} />);
    expect(html).not.toContain('data-quiet');
    expect(html).not.toContain('bg-muted/60');
  });
});
