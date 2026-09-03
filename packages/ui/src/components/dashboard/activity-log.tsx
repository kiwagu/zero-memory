import { ChevronRight } from 'lucide-react';
import * as React from 'react';

import { Badge } from '@workspace/ui/components/badge';
import { Card, CardContent } from '@workspace/ui/components/card';
import { EmptyState } from '@workspace/ui/components/common/empty-state';
import { cn } from '@workspace/ui/lib/utils';

/**
 * ActivityLog — the memory-activity feed. Each row is a TWO-LINE header: the
 * meta line (stable colored dot per actor, the tool, the outcome badge
 * hit/empty/error, a timestamp) over the query the client actually sent —
 * "what was asked" is what explains an outcome, so it is readable without
 * opening anything, and a chevron marks the row as openable instead of
 * leaving the drill-down to be discovered by accident. Expanding reveals the
 * surfaced-fact previews linking to their detail pages, the request id, and
 * the full query when it was clamped.
 * Mechanism only: every string, badge variant, dot class and href arrives
 * preformatted from the caller so i18n, time formatting and actor hashing
 * stay in the app.
 */

export type ActivityLogFact = {
  id: string;
  /** Preview text (owned facts) or the bare id (foreign/hidden facts). */
  label: string;
  /** Detail-page href; omitted when the fact is not navigable. */
  href?: string;
  /** Kind pill text; omitted for foreign/hidden facts. */
  kindLabel?: string;
};

export type ActivityLogItem = {
  id: string;
  /** Actor line, e.g. an agent name or "you". */
  actorLabel: string;
  /** Tailwind bg-class for the actor's stable colored dot. */
  dotClassName: string;
  /** Tool line, e.g. "recall" / "context build". */
  toolLabel: string;
  /** Preformatted surfaced-count, e.g. "3 facts"; omitted when unknown. */
  countLabel?: string;
  outcome: {
    label: string;
    variant: 'green' | 'amber' | 'destructive' | 'outline';
  };
  timeLabel: string;
  /** The search string the client sent — the header's second line. */
  queryLabel?: string;
  /** Request correlation id (mono meta line in the expanded header). */
  requestId?: string;
  /** Surfaced-fact previews (the expandable drill-down); empty = no toggle. */
  facts: ActivityLogFact[];
  /**
   * Facts held back behind the "+N more" disclosure, with the label that
   * announces them. They ship WITH the row and are revealed in place: the
   * reveal used to be a link back to the page, which re-rendered the feed and
   * scrolled the row the reader was looking at out from under them.
   */
  moreFacts?: { label: string; facts: ActivityLogFact[] };
};

/**
 * One fact line, shared by the always-visible list and the "+N more"
 * disclosure so the two can never drift apart.
 */
const factBody = (
  fact: ActivityLogFact,
  LinkComponent: React.ElementType
): React.ReactNode => (
  <>
    {fact.kindLabel ? <Badge variant="blue">{fact.kindLabel}</Badge> : null}
    {fact.href ? (
      <LinkComponent
        href={fact.href}
        className="min-w-0 truncate hover:underline"
      >
        {fact.label}
      </LinkComponent>
    ) : (
      <span className="text-muted-foreground min-w-0 truncate font-mono text-xs">
        {fact.label}
      </span>
    )}
  </>
);

export function ActivityLog({
  items,
  emptyLabel,
  linkComponent: LinkComponent = 'a',
  className,
  ...props
}: React.ComponentPropsWithoutRef<'div'> & {
  items: ActivityLogItem[];
  emptyLabel: string;
  /** Client-router link injected by the app (e.g. next/link). */
  linkComponent?: React.ElementType;
}) {
  if (items.length === 0) {
    return (
      <EmptyState
        className="rounded-xl border border-dashed"
        data-testid="activity-empty"
      >
        {emptyLabel}
      </EmptyState>
    );
  }

  return (
    <div className={cn('space-y-2', className)} {...props}>
      {items.map((item) => {
        const metaLine = (
          <>
            <span
              aria-hidden
              className={cn(
                'inline-block size-2 shrink-0 rounded-full',
                item.dotClassName
              )}
            />
            <span className="text-sm font-medium">{item.actorLabel}</span>
            <span className="text-muted-foreground text-sm">
              {item.toolLabel}
            </span>
            <Badge
              variant={item.outcome.variant}
              data-testid={`activity-outcome-${item.outcome.variant}`}
            >
              {item.outcome.label}
            </Badge>
            {item.countLabel ? (
              <span className="text-muted-foreground text-xs">
                {item.countLabel}
              </span>
            ) : null}
            <span className="text-muted-foreground ml-auto text-xs">
              {item.timeLabel}
            </span>
          </>
        );

        // The header carries the query itself, so a row is openable only when
        // something is still hidden behind it: the surfaced facts, or the
        // request id. A row with neither stays flat — no chevron promising a
        // drill-down that would open onto nothing.
        const expandable = item.facts.length > 0 || Boolean(item.requestId);

        // Second header line. Clamped to one line while closed so the feed
        // keeps its rhythm; the open row shows the query in full.
        const header = (
          <div className="min-w-0 flex-1 space-y-1">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              {metaLine}
            </div>
            {item.queryLabel ? (
              <p
                className="line-clamp-1 text-sm group-open:line-clamp-none"
                data-testid="activity-query"
              >
                “{item.queryLabel}”
              </p>
            ) : null}
          </div>
        );

        return (
          <Card key={item.id} className="py-3" data-testid="activity-row">
            <CardContent>
              {expandable ? (
                <details className="group">
                  <summary className="flex cursor-pointer list-none items-start gap-2 [&::-webkit-details-marker]:hidden">
                    <ChevronRight
                      aria-hidden
                      className="text-muted-foreground group-hover:text-foreground mt-0.5 size-4 shrink-0 transition-transform group-open:rotate-90"
                      data-testid="activity-toggle"
                    />
                    {header}
                  </summary>
                  {item.requestId ? (
                    <div
                      className="mt-3 pl-6"
                      data-testid="activity-detail-header"
                    >
                      <span className="text-muted-foreground font-mono text-xs select-all">
                        {item.requestId}
                      </span>
                    </div>
                  ) : null}
                  {item.facts.length > 0 ? (
                    <ul
                      className="mt-3 ml-6 space-y-1.5 border-l-2 pl-4"
                      data-testid="activity-facts"
                    >
                      {item.facts.map((fact) => (
                        <li
                          key={fact.id}
                          className="flex items-baseline gap-2 text-sm"
                        >
                          {factBody(fact, LinkComponent)}
                        </li>
                      ))}
                      {item.moreFacts ? (
                        <li>
                          <details className="group/more">
                            <summary
                              className="text-muted-foreground hover:text-foreground cursor-pointer list-none text-xs hover:underline group-open/more:hidden [&::-webkit-details-marker]:hidden"
                              data-testid="activity-more"
                            >
                              {item.moreFacts.label}
                            </summary>
                            <ul className="space-y-1.5">
                              {item.moreFacts.facts.map((fact) => (
                                <li
                                  key={fact.id}
                                  className="flex items-baseline gap-2 text-sm"
                                >
                                  {factBody(fact, LinkComponent)}
                                </li>
                              ))}
                            </ul>
                          </details>
                        </li>
                      ) : null}
                    </ul>
                  ) : null}
                </details>
              ) : (
                // Flat rows keep the chevron's gutter so both kinds of row
                // line up in the feed.
                <div className="flex items-start gap-2">
                  <span aria-hidden className="size-4 shrink-0" />
                  {header}
                </div>
              )}
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}
