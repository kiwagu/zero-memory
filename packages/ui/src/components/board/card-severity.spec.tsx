import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { CardSeverity } from '@workspace/ui/components/board/card-severity';

describe('CardSeverity', () => {
  it('draws five ticks, fills as many as the level, and says the level in words', () => {
    const html = renderToStaticMarkup(
      <CardSeverity level={4} hint="Severity 4 of 5: high" />
    );
    expect(html).toContain('data-testid="card-severity"');
    expect(html).toContain('data-severity="4"');
    expect(html).toContain('title="Severity 4 of 5: high"');
    expect(html.match(/data-filled="true"/g)).toHaveLength(4);
    expect(html.match(/data-filled="false"/g)).toHaveLength(1);
  });

  it('is drawn at the normal level too, so the scale reads the same on every card', () => {
    const html = renderToStaticMarkup(
      <CardSeverity level={3} hint="Severity 3 of 5: normal" />
    );
    expect(html).toContain('data-severity="3"');
    expect(html.match(/data-filled="true"/g)).toHaveLength(3);
  });
});
