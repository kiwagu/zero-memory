import * as React from 'react';

import { Badge } from '@workspace/ui/components/badge';
import {
  BoardCardTile,
  type BoardColumnCard,
} from '@workspace/ui/components/board/board-card-tile';
import { BoardColumnFold } from '@workspace/ui/components/board/board-column-fold';
import { type BadgeListVariant } from '@workspace/ui/components/common/badge-list';
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

interface BoardColumn {
  key: string;
  label: string;
  variant?: BadgeListVariant;
  /** The cards on screen. */
  cards: BoardColumnCard[];
  /** The cards that went quiet past the horizon, folded behind an arrow. */
  older?: BoardColumnCard[];
  /** What the arrow says, folded and open. Required when `older` has cards. */
  olderHints?: { show: string; hide: string };
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
  // A board whose every card went quiet is not empty: its cards are folded.
  const total = columns.reduce(
    (sum, column) => sum + column.cards.length + (column.older?.length ?? 0),
    0
  );

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
          <BoardColumnFold
            key={column.key}
            columnKey={column.key}
            header={
              <Badge variant={column.variant ?? 'secondary'}>
                {column.label}
              </Badge>
            }
            recent={column.cards.map((card) => (
              <BoardCardTile
                key={card.id}
                card={card}
                linkComponent={LinkComponent}
              />
            ))}
            recentCount={column.cards.length}
            older={column.older?.map((card) => (
              <BoardCardTile
                key={card.id}
                card={card}
                linkComponent={LinkComponent}
              />
            ))}
            olderCount={column.older?.length ?? 0}
            olderHints={column.olderHints}
          />
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
