import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import {
  CardLinks,
  type CardLinkGroup,
} from '@workspace/ui/components/board/card-links';

const item = (
  number: number,
  relationLabel: string,
  extra: { undeclaredLabel?: string } = {}
) => ({
  key: `${relationLabel}:${number}`,
  href: `/board/crd_${number}`,
  relationLabel,
  numberLabel: `ZM-${number}`,
  title: `Card ${number}`,
  stateLabel: 'Active',
  stateVariant: 'blue' as const,
  reason: `why ${number}`,
  ...extra,
});

describe('CardLinks', () => {
  it('shows each side that holds a relation, in the order given, and skips empty ones', () => {
    const groups: CardLinkGroup[] = [
      {
        key: 'above',
        label: 'Above',
        items: [item(12, 'child of'), item(28, 'blocked by')],
      },
      { key: 'below', label: 'Below', items: [] },
      {
        key: 'related',
        label: 'Related',
        items: [
          item(7, 'relates to', { undeclaredLabel: 'type not declared' }),
        ],
      },
    ];
    const out = renderToStaticMarkup(
      <CardLinks groups={groups} emptyLabel="Not related to any other card." />
    );
    expect(out).toContain('data-testid="card-links-group-above"');
    expect(out).toContain('data-testid="card-links-group-related"');
    expect(out).not.toContain('card-links-group-below');
    expect(out.indexOf('ZM-12')).toBeLessThan(out.indexOf('ZM-28'));
    expect(out.indexOf('ZM-28')).toBeLessThan(out.indexOf('ZM-7'));
    expect(out).toContain('href="/board/crd_28"');
    expect(out).toContain('why 28');
    expect(out).toContain('type not declared');
    expect(out.match(/type not declared/g)).toHaveLength(1);
    expect(out).not.toContain('Not related to any other card.');
  });

  it('names the board of a card on another one, and marks an archived card', () => {
    const out = renderToStaticMarkup(
      <CardLinks
        groups={[
          {
            key: 'above',
            label: 'Above',
            items: [
              { ...item(3, 'blocked by'), boardLabel: 'acme' },
              { ...item(12, 'child of'), archivedLabel: 'archived' },
            ],
          },
        ]}
        emptyLabel="Not related to any other card."
      />
    );
    expect(out).toContain('data-testid="card-link-board"');
    expect(out).toContain('acme');
    expect(out).toContain('data-testid="card-link-archived"');
    expect(out).toContain('archived');
    expect(out.match(/card-link-board/g)).toHaveLength(1);
    expect(out.match(/card-link-archived/g)).toHaveLength(1);
  });

  it('says so when the card relates to nothing, and offers no control', () => {
    const out = renderToStaticMarkup(
      <CardLinks
        groups={[{ key: 'above', label: 'Above', items: [] }]}
        emptyLabel="Not related to any other card."
      />
    );
    expect(out).toContain('Not related to any other card.');
    expect(out).not.toContain('<button');
    expect(out).not.toContain('<form');
  });
});
