import * as React from 'react';

import { Badge } from '@workspace/ui/components/badge';
import { Card, CardContent } from '@workspace/ui/components/card';
import {
  BadgeList,
  type BadgeListItem,
  type BadgeListVariant,
} from '@workspace/ui/components/common/badge-list';
import { EmptyState } from '@workspace/ui/components/common/empty-state';

/**
 * BoardColumns — the project board read as columns of cards.
 *
 * Display-only, like every component in this package: labels, hrefs and the
 * reason text arrive resolved from the app. It deliberately offers NO
 * interaction beyond following a card's link — a board that could move a card
 * would have nowhere to put the justification the move must carry, so the
 * absence of a control here is the design, not an omission.
 */

interface BoardColumnCard {
  id: string;
  href: string;
  /** The project-local address, already formatted (e.g. `ZM-42`). */
  numberLabel: string;
  title: string;
  badges: BadgeListItem[];
  /** What last happened and when, in one line. */
  lastEventLabel?: string;
  /** The reason its author gave for that change. */
  reason?: string;
}

interface BoardColumn {
  key: string;
  label: string;
  variant?: BadgeListVariant;
  cards: BoardColumnCard[];
}

interface BoardColumnsProps {
  columns: BoardColumn[];
  /** Shown once, above the columns, when the whole board is empty. */
  emptyLabel: string;
  /** Client-router link injected by the app; plain <a> by default. */
  linkComponent?: React.ElementType;
}

function BoardColumns({
  columns,
  emptyLabel,
  linkComponent: LinkComponent = 'a',
}: BoardColumnsProps) {
  const total = columns.reduce((sum, column) => sum + column.cards.length, 0);

  if (total === 0) {
    return <EmptyState data-testid="board-empty">{emptyLabel}</EmptyState>;
  }

  return (
    // One row of columns at every width. Where the window is narrower than the
    // board, the row scrolls sideways instead of wrapping: stacked into blocks,
    // a board loses what it shows at a glance — where each card stands next to
    // the others. The inset keeps focus rings clear of the scroll clip.
    <div className="-m-1 overflow-x-auto p-1 pb-3" data-testid="board-columns">
      <div className="flex gap-4">
        {columns.map((column) => (
          <section
            key={column.key}
            className="flex min-w-64 flex-1 basis-0 flex-col gap-3"
            data-testid={`board-column-${column.key}`}
          >
            <div className="flex items-center justify-between">
              <Badge variant={column.variant ?? 'secondary'}>
                {column.label}
              </Badge>
              <span className="text-muted-foreground text-xs tabular-nums">
                {column.cards.length}
              </span>
            </div>

            {column.cards.map((card) => (
              <LinkComponent
                key={card.id}
                href={card.href}
                data-testid="board-card"
                className="focus-visible:ring-ring rounded-lg focus-visible:ring-2 focus-visible:outline-none"
              >
                <Card className="hover:border-ring transition-colors">
                  <CardContent className="flex flex-col gap-2 p-3">
                    <div className="flex items-baseline gap-2">
                      {/* The label never breaks: `ZM-12` split after its
                          hyphen reads as two things. The title wraps. */}
                      <span
                        className="text-muted-foreground shrink-0 text-xs whitespace-nowrap tabular-nums"
                        data-testid="board-card-number"
                      >
                        {card.numberLabel}
                      </span>
                      <span className="text-sm leading-snug font-medium">
                        {card.title}
                      </span>
                    </div>

                    <BadgeList badges={card.badges} />

                    {card.lastEventLabel ? (
                      <div className="text-muted-foreground flex flex-col gap-0.5 text-xs">
                        <span>{card.lastEventLabel}</span>
                        {card.reason ? (
                          <span className="text-foreground/80 italic">
                            {card.reason}
                          </span>
                        ) : null}
                      </div>
                    ) : null}
                  </CardContent>
                </Card>
              </LinkComponent>
            ))}
          </section>
        ))}
      </div>
    </div>
  );
}

export {
  BoardColumns,
  type BoardColumn,
  type BoardColumnCard,
  type BoardColumnsProps,
};
