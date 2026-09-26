import * as React from 'react';

import { EmptyState } from '@workspace/ui/components/common/empty-state';
import {
  BoardCardTile,
  type BoardColumnCard,
} from '@workspace/ui/components/board/board-card-tile';

/**
 * BoardCardList — cards as one list, in the order given: the board read as
 * "what I worked on, newest first" rather than as columns of state.
 * Display-only; an empty list says so rather than showing another board.
 */
function BoardCardList({
  cards,
  emptyLabel,
  linkComponent,
}: {
  cards: BoardColumnCard[];
  emptyLabel: string;
  /** Client-router link injected by the app; plain <a> by default. */
  linkComponent?: React.ElementType;
}) {
  if (cards.length === 0) {
    return <EmptyState data-testid="board-mine-empty">{emptyLabel}</EmptyState>;
  }
  return (
    <div
      className="flex max-w-3xl flex-col gap-3"
      data-testid="board-mine-list"
    >
      {cards.map((card) => (
        <BoardCardTile
          key={card.id}
          card={card}
          linkComponent={linkComponent}
        />
      ))}
    </div>
  );
}

export { BoardCardList };
