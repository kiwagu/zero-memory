import * as React from 'react';

import { Card, CardContent } from '@workspace/ui/components/card';
import {
  BadgeList,
  type BadgeListVariant,
} from '@workspace/ui/components/common/badge-list';

/**
 * BoardContinuation — the card a new session would be offered to continue,
 * shown to the person and not only to the agent.
 *
 * Display-only: every label arrives resolved from the app. One item per board
 * that has something to say. An item with no card says that nothing is
 * offered and still names the last step; no items at all say the same once.
 * An absent offer is an answer, so it is stated rather than hidden.
 */
interface BoardContinuationItem {
  key: string;
  /** The board it belongs to, when several are on screen. */
  scopeLabel?: string;
  /** Present when a card is offered. */
  href?: string;
  numberLabel?: string;
  title?: string;
  stateLabel?: string;
  stateVariant?: BadgeListVariant;
  /** Why the card sits in its column. */
  reason?: string;
  /** Your latest step on it, and what you said. */
  lastStepLabel?: string;
  lastStepText?: string;
  /** Your latest step, when it was on another card. */
  lastSessionLabel?: string;
}

interface BoardContinuationProps {
  heading: string;
  items: BoardContinuationItem[];
  /** Said in place of a card when nothing is offered. */
  emptyLabel: string;
  /** Client-router link injected by the app; plain <a> by default. */
  linkComponent?: React.ElementType;
}

function BoardContinuation({
  heading,
  items,
  emptyLabel,
  linkComponent: LinkComponent = 'a',
}: BoardContinuationProps) {
  return (
    <section
      className="flex max-w-3xl flex-col gap-2"
      data-testid="board-continuation"
    >
      <h2 className="text-muted-foreground text-sm font-medium">{heading}</h2>
      {items.length === 0 ? (
        <p
          className="text-muted-foreground text-sm"
          data-testid="board-continuation-empty"
        >
          {emptyLabel}
        </p>
      ) : (
        items.map((item) => (
          <div
            key={item.key}
            className="flex flex-col gap-1"
            data-testid="board-continuation-item"
          >
            {item.href ? (
              <LinkComponent
                href={item.href}
                data-testid="board-continuation-card"
                className="focus-visible:ring-ring rounded-lg focus-visible:ring-2 focus-visible:outline-none"
              >
                <Card className="border-primary/40 hover:border-ring transition-colors">
                  <CardContent className="flex flex-col gap-2 p-3">
                    <div className="flex items-baseline gap-2">
                      <span className="text-muted-foreground shrink-0 text-xs whitespace-nowrap tabular-nums">
                        {item.numberLabel}
                      </span>
                      <span className="text-sm leading-snug font-medium">
                        {item.title}
                      </span>
                    </div>
                    <BadgeList
                      badges={[
                        ...(item.stateLabel
                          ? [
                              {
                                label: item.stateLabel,
                                variant: item.stateVariant ?? 'secondary',
                              },
                            ]
                          : []),
                        ...(item.scopeLabel
                          ? [
                              {
                                label: item.scopeLabel,
                                variant: 'outline' as const,
                              },
                            ]
                          : []),
                      ]}
                    />
                    {item.reason ? (
                      <span className="text-foreground/80 text-xs italic">
                        {item.reason}
                      </span>
                    ) : null}
                    {item.lastStepLabel ? (
                      <div className="text-muted-foreground flex flex-col gap-0.5 text-xs">
                        <span>{item.lastStepLabel}</span>
                        {item.lastStepText ? (
                          <span className="text-foreground/80 italic">
                            {item.lastStepText}
                          </span>
                        ) : null}
                      </div>
                    ) : null}
                  </CardContent>
                </Card>
              </LinkComponent>
            ) : (
              <div
                className="text-muted-foreground flex flex-wrap items-center gap-2 text-sm"
                data-testid="board-continuation-empty"
              >
                {item.scopeLabel ? (
                  <BadgeList
                    badges={[{ label: item.scopeLabel, variant: 'outline' }]}
                  />
                ) : null}
                <span>{emptyLabel}</span>
              </div>
            )}
            {item.lastSessionLabel ? (
              <span
                className="text-muted-foreground text-xs"
                data-testid="board-continuation-last-session"
              >
                {item.lastSessionLabel}
              </span>
            ) : null}
          </div>
        ))
      )}
    </section>
  );
}

export {
  BoardContinuation,
  type BoardContinuationItem,
  type BoardContinuationProps,
};
