import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { CardType } from '@workspace/ui/components/board/card-type';

describe('CardType', () => {
  it.each(['story', 'bug', 'task', 'spike'] as const)(
    'draws the %s icon and says the type in words',
    (type) => {
      const html = renderToStaticMarkup(
        <CardType type={type} hint={`Type: ${type}`} />
      );
      expect(html).toContain('data-testid="card-type"');
      expect(html).toContain(`data-type="${type}"`);
      expect(html).toContain('role="img"');
      expect(html).toContain(`aria-label="Type: ${type}"`);
      expect(html).toContain('<svg');
    }
  );

  it('draws a placeholder for a card that predates types', () => {
    const html = renderToStaticMarkup(
      <CardType type={null} hint="Type not declared" />
    );
    expect(html).toContain('data-type="none"');
    expect(html).toContain('aria-label="Type not declared"');
  });
});
