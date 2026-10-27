import * as React from 'react';

import { Badge } from '@workspace/ui/components/badge';
import { EmptyState } from '@workspace/ui/components/common/empty-state';

/**
 * CardLinks — how a card stands to other cards, grouped by side: what is
 * above it (its parent, what blocks it, what it depends on), what hangs
 * below it, what merely relates to it, and its duplicates. Each relation
 * reads from this card's side — "blocked by ZM-28" — with the reason it was
 * declared with, and the other card's label opens that card.
 *
 * Display-only: relations are declared through the tools, with a reason, and
 * every label arrives translated from the app.
 */

interface CardLinkItem {
  key: string;
  /** Where the other card opens. */
  href: string;
  /** How this card stands to the other one, e.g. "blocked by". */
  relationLabel: string;
  /** The other card's label, e.g. `ZM-28`. */
  numberLabel: string;
  title: string;
  stateLabel: string;
  stateVariant: React.ComponentProps<typeof Badge>['variant'];
  reason: string;
  /** Set when nobody typed the relation: it was carried over from an
   * attachment. */
  undeclaredLabel?: string;
  /** Set for a card on another board: that board's name, since a number
   * alone names a card of this one. */
  boardLabel?: string;
  /** Set when the other card was archived. */
  archivedLabel?: string;
}

interface CardLinkGroup {
  /** Stable id of the side: above, below, related, duplicates. */
  key: string;
  label: string;
  items: CardLinkItem[];
}

function CardLinks({
  groups,
  emptyLabel,
  linkComponent: LinkComponent = 'a',
}: {
  groups: CardLinkGroup[];
  emptyLabel: string;
  /** Client-router link injected by the app (e.g. next/link); plain <a> by default. */
  linkComponent?: React.ElementType;
}) {
  const shown = groups.filter((group) => group.items.length > 0);
  if (shown.length === 0) {
    return <EmptyState compact>{emptyLabel}</EmptyState>;
  }

  return (
    <div className="flex flex-col gap-4" data-testid="card-links">
      {shown.map((group) => (
        <div
          key={group.key}
          className="flex flex-col gap-2"
          data-testid={`card-links-group-${group.key}`}
        >
          <h3 className="text-muted-foreground text-xs font-medium uppercase">
            {group.label}
          </h3>
          <ul className="flex flex-col gap-2">
            {group.items.map((item) => (
              <li
                key={item.key}
                className="flex flex-col gap-0.5 text-sm"
                data-testid="card-link"
              >
                <div className="flex flex-wrap items-baseline gap-x-1">
                  <span className="text-muted-foreground">
                    {item.relationLabel}
                  </span>{' '}
                  <LinkComponent
                    href={item.href}
                    className="font-mono underline-offset-2 hover:underline"
                  >
                    {item.numberLabel}
                  </LinkComponent>{' '}
                  {item.boardLabel ? (
                    <>
                      <Badge
                        variant="outline"
                        className="font-mono"
                        data-testid="card-link-board"
                      >
                        {item.boardLabel}
                      </Badge>{' '}
                    </>
                  ) : null}
                  <span className="min-w-0">{item.title}</span>{' '}
                  <Badge variant={item.stateVariant}>{item.stateLabel}</Badge>
                  {item.archivedLabel ? (
                    <>
                      {' '}
                      <Badge
                        variant="secondary"
                        data-testid="card-link-archived"
                      >
                        {item.archivedLabel}
                      </Badge>
                    </>
                  ) : null}
                  {item.undeclaredLabel ? (
                    <>
                      {' '}
                      <Badge variant="outline">{item.undeclaredLabel}</Badge>
                    </>
                  ) : null}
                </div>
                <p className="text-foreground/80 text-xs italic">
                  {item.reason}
                </p>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

export { CardLinks, type CardLinkGroup, type CardLinkItem };
