import * as React from 'react';

import {
  CardBranches,
  type CardBranchItem,
} from '@workspace/ui/components/board/card-branches';
import {
  CardHistory,
  type CardHistoryEntry,
} from '@workspace/ui/components/board/card-history';
import { Card, CardContent } from '@workspace/ui/components/card';
import {
  BadgeList,
  type BadgeListItem,
} from '@workspace/ui/components/common/badge-list';
import { DetailSection } from '@workspace/ui/components/common/detail-section';
import { EmptyState } from '@workspace/ui/components/common/empty-state';
import { Markdown } from '@workspace/ui/components/common/markdown';
import {
  LinkedMemoryList,
  type LinkedMemoryItem,
} from '@workspace/ui/components/memory/linked-memory-list';

/**
 * CardDetail — one card: its document, where its work ran, what it points
 * at, what its bound conversations remembered, and everything that happened
 * to it.
 *
 * Rendered by the card's page, by the dialog over the board and by a panel of
 * the chain, so the view knows none of them: everything arrives display-ready
 * and serializable, and what differs — the way back, the live subscription —
 * comes in as `header` and `footer`. There is deliberately no control that
 * changes the card.
 */

interface CardDetailData {
  /** The card's label, already formatted (e.g. `ZM-42`). */
  numberLabel: string;
  title: string;
  badges: BadgeListItem[];
  /** "Updated <time>", already formatted. */
  updatedLabel: string;
  /** Where the work came from, when it began as a handover. */
  originLoop: { label: string; id: string; href: string } | null;
  body: string;
  /** The git branches its work ran on, open or landed. */
  branches: { title: string; items: CardBranchItem[]; emptyLabel: string };
  refs: { title: string; items: LinkedMemoryItem[]; emptyLabel: string };
  feed: {
    title: string;
    items: LinkedMemoryItem[];
    emptyLabel: string;
    moreLabel: string | null;
  };
  history: {
    title: string;
    entries: CardHistoryEntry[];
    emptyLabel: string;
    moreLabel: string | null;
  };
  hiddenLabel: string;
  imageLabel: string;
}

interface CardDetailProps extends CardDetailData {
  /** Client-router link injected by the app (e.g. next/link); plain <a> by default. */
  linkComponent?: React.ElementType;
  header?: React.ReactNode;
  footer?: React.ReactNode;
}

function CardDetail({
  numberLabel,
  title,
  badges,
  updatedLabel,
  originLoop,
  body,
  branches,
  refs,
  feed,
  history,
  hiddenLabel,
  imageLabel,
  linkComponent: LinkComponent = 'a',
  header,
  footer,
}: CardDetailProps) {
  return (
    <div className="flex flex-col gap-6" data-testid="card-detail">
      {header}

      <header className="flex flex-col gap-2">
        {/* The label and the title share one line; a long title wraps in its
            own column, indented past the label, the way a board tile does. */}
        <div className="flex items-baseline gap-2">
          <span
            className="text-muted-foreground shrink-0 text-sm whitespace-nowrap tabular-nums"
            data-testid="card-number"
          >
            {numberLabel}
          </span>
          <h1
            className="min-w-0 text-2xl font-semibold"
            data-testid="card-title"
          >
            {title}
          </h1>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <BadgeList badges={badges} />
          <span className="text-muted-foreground text-xs">{updatedLabel}</span>
        </div>
        {/* Where the work came from, when it began as a handover. The loop
            itself stays in history: promoting is not finishing. */}
        {originLoop ? (
          <p className="text-muted-foreground text-xs">
            {originLoop.label}{' '}
            <LinkComponent
              href={originLoop.href}
              className="hover:text-foreground underline underline-offset-2"
            >
              {originLoop.id}
            </LinkComponent>
          </p>
        ) : null}
      </header>

      {body.trim() !== '' ? (
        <Card>
          <CardContent className="p-4">
            <Markdown
              data-testid="card-body"
              linkComponent={LinkComponent}
              imageLabel={imageLabel}
            >
              {body}
            </Markdown>
          </CardContent>
        </Card>
      ) : null}

      <DetailSection title={branches.title} data-testid="card-branches-section">
        {branches.items.length === 0 ? (
          <EmptyState compact>{branches.emptyLabel}</EmptyState>
        ) : (
          <CardBranches items={branches.items} />
        )}
      </DetailSection>

      <DetailSection title={refs.title} data-testid="card-refs">
        {refs.items.length === 0 ? (
          <EmptyState compact>{refs.emptyLabel}</EmptyState>
        ) : (
          <LinkedMemoryList
            items={refs.items}
            hiddenLabel={hiddenLabel}
            linkComponent={LinkComponent}
          />
        )}
      </DetailSection>

      <DetailSection title={feed.title} data-testid="card-feed">
        {feed.items.length === 0 ? (
          <EmptyState compact>{feed.emptyLabel}</EmptyState>
        ) : (
          <LinkedMemoryList
            items={feed.items}
            hiddenLabel={hiddenLabel}
            linkComponent={LinkComponent}
          />
        )}
        {feed.moreLabel ? (
          <p className="text-muted-foreground mt-3 text-xs">{feed.moreLabel}</p>
        ) : null}
      </DetailSection>

      <DetailSection title={history.title}>
        <CardHistory
          entries={history.entries}
          emptyLabel={history.emptyLabel}
          linkComponent={LinkComponent}
        />
        {history.moreLabel ? (
          <p className="text-muted-foreground mt-3 text-xs">
            {history.moreLabel}
          </p>
        ) : null}
      </DetailSection>

      {footer}
    </div>
  );
}

export { CardDetail, type CardDetailData, type CardDetailProps };
