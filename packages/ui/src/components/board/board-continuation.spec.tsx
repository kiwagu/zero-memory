import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { BoardContinuation } from '@workspace/ui/components/board/board-continuation';

const EMPTY = 'A new session gets nothing to continue.';

describe('BoardContinuation', () => {
  it('says so when nothing is offered, instead of showing nothing', () => {
    const html = renderToStaticMarkup(
      <BoardContinuation heading="Continue" items={[]} emptyLabel={EMPTY} />
    );
    expect(html).toContain('data-testid="board-continuation-empty"');
    expect(html).toContain(EMPTY);
  });

  it('links the offered card, with why it is active and my last step on it', () => {
    const html = renderToStaticMarkup(
      <BoardContinuation
        heading="Continue"
        emptyLabel={EMPTY}
        items={[
          {
            key: 'proj.acme',
            href: '/board/crd_31',
            numberLabel: 'ZM-31',
            title: 'See my cards',
            stateLabel: 'Active',
            stateVariant: 'blue',
            reason: 'picked up by the owner',
            lastStepLabel: 'your step: moved → Active · 2026-09-26 06:39 UTC',
            lastStepText: 'design pass first',
            lastSessionLabel: 'last session: ZM-30 moved → Done',
          },
        ]}
      />
    );
    expect(html).toContain('href="/board/crd_31"');
    expect(html).toContain('ZM-31');
    expect(html).toContain('picked up by the owner');
    expect(html).toContain('design pass first');
    expect(html).toContain('last session: ZM-30 moved → Done');
    expect(html).not.toContain(EMPTY);
  });

  it('a board with no card to offer says so and still names the last step', () => {
    const html = renderToStaticMarkup(
      <BoardContinuation
        heading="Continue"
        emptyLabel={EMPTY}
        items={[
          {
            key: 'proj.acme',
            scopeLabel: 'acme',
            lastSessionLabel: 'last session: ZM-30 moved → Done',
          },
        ]}
      />
    );
    expect(html).toContain(EMPTY);
    expect(html).toContain('acme');
    expect(html).toContain('data-testid="board-continuation-last-session"');
    expect(html).not.toContain('board-continuation-card');
  });

  it('renders no control', () => {
    const html = renderToStaticMarkup(
      <BoardContinuation heading="Continue" items={[]} emptyLabel={EMPTY} />
    );
    expect(html).not.toMatch(/<(button|form|input|select)\b/u);
  });
});
