import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { InfoHint } from '@workspace/ui/components/common/info-hint';

describe('InfoHint', () => {
  it('renders a labelled icon and keeps its text off the page until opened', () => {
    const out = renderToStaticMarkup(
      <InfoHint label="About this board" testId="board-hint">
        <p>The board is a window.</p>
      </InfoHint>
    );
    expect(out).toContain('aria-label="About this board"');
    expect(out).toContain('data-testid="board-hint"');
    expect(out).not.toContain('The board is a window.');
  });
});
