import * as React from 'react';

import {
  CardSeverity,
  type CardSeverityProps,
} from '@workspace/ui/components/board/card-severity';
import {
  CardType,
  type CardTypeProps,
} from '@workspace/ui/components/board/card-type';
import { Card, CardContent } from '@workspace/ui/components/card';
import {
  BadgeList,
  type BadgeListItem,
} from '@workspace/ui/components/common/badge-list';

/**
 * BoardCardTile — one card as the board shows it: its label, its title, its
 * badges, and one line of what happened with the reason its author gave.
 *
 * Display-only. The columns and the list of a person's own cards draw the
 * same tile, so a card reads the same wherever it appears.
 */
interface BoardColumnCard {
  id: string;
  href: string;
  /** The project-local address, already formatted (e.g. `ZM-42`). */
  numberLabel: string;
  title: string;
  /** How much it matters, drawn under the label. */
  severity?: Pick<CardSeverityProps, 'level' | 'hint'>;
  /** Why the work exists, drawn as an icon under the severity. */
  type?: Pick<CardTypeProps, 'type' | 'hint'>;
  badges: BadgeListItem[];
  /** What last happened and when, in one line. */
  lastEventLabel?: string;
  /** The reason its author gave for that change. */
  reason?: string;
}

function BoardCardTile({
  card,
  quiet = false,
  linkComponent: LinkComponent = 'a',
}: {
  card: BoardColumnCard;
  /** A card that went quiet past the horizon: drawn dimmed. */
  quiet?: boolean;
  /** Client-router link injected by the app; plain <a> by default. */
  linkComponent?: React.ElementType;
}) {
  return (
    <LinkComponent
      href={card.href}
      data-testid="board-card"
      data-quiet={quiet ? 'true' : undefined}
      className="focus-visible:ring-ring rounded-lg focus-visible:ring-2 focus-visible:outline-none"
    >
      <Card
        className={
          quiet
            ? 'bg-muted/60 hover:border-ring transition-colors'
            : 'hover:border-ring transition-colors'
        }
      >
        <CardContent className="flex flex-col gap-2 p-3">
          <div className="flex items-start gap-2">
            {/* The label never breaks: `ZM-12` split after its hyphen reads
                as two things. The title wraps beside it, and the severity
                sits under the label, in the room a wrapped title leaves. */}
            <span className="flex shrink-0 flex-col items-stretch gap-1 pt-0.5">
              <span
                className="text-muted-foreground text-xs whitespace-nowrap tabular-nums"
                data-testid="board-card-number"
              >
                {card.numberLabel}
              </span>
              {card.severity || card.type ? (
                // The type icon leads, and the ticks take what is left of
                // the label's width.
                <span className="flex items-center gap-1">
                  {card.type ? (
                    <CardType
                      type={card.type.type}
                      hint={card.type.hint}
                      className="shrink-0"
                    />
                  ) : null}
                  {card.severity ? (
                    <CardSeverity
                      level={card.severity.level}
                      hint={card.severity.hint}
                      className="min-w-0 flex-1"
                    />
                  ) : null}
                </span>
              ) : null}
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
                <span className="text-foreground/80 italic">{card.reason}</span>
              ) : null}
            </div>
          ) : null}
        </CardContent>
      </Card>
    </LinkComponent>
  );
}

export { BoardCardTile, type BoardColumnCard };
