import Link from 'next/link';
import { notFound } from 'next/navigation';

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

import { BoardLive } from '@/components/board-live.client';
import {
  cardEventLabel,
  cardRefHref,
  cardRelationLabel,
  cardStateLabel,
  cardFeedSchema,
  cardStateVariant,
  cardViewSchema,
} from '@/lib/board';
import { getRequestMessages } from '@/lib/i18n';
import { formatTimestamp, kindLabel, scopeLabel } from '@/lib/memory';
import { createServerSupabaseClient } from '@/lib/supabase/server';

/** Events fetched per view. */
const HISTORY_LIMIT = 200;
/** The newest feed entries shown on a card; older ones stay reachable by MCP. */
const FEED_LIMIT = 50;

/**
 * One card: its document, what it points at, and everything that happened.
 *
 * Rendered by two routes that must not drift — the page a link or a reload
 * lands on, and the dialog a click from the board opens over it. Both show the
 * same thing; only the chrome differs, which is what `variant` selects: a page
 * needs a way back and owns the live subscription, a dialog has its own close
 * and sits on a board that is already subscribed.
 */
export async function CardView({
  id,
  variant = 'page',
}: {
  id: string;
  variant?: 'page' | 'modal';
}) {
  const { t } = await getRequestMessages();

  const supabase = await createServerSupabaseClient();
  const { data } = await supabase.rpc('card_get', {
    p_card_id: id,
    p_limit: HISTORY_LIMIT,
  });

  const parsed = data ? cardViewSchema.safeParse(data) : null;
  if (!parsed?.success) {
    // A card outside the reader's scopes is indistinguishable from one that
    // does not exist, and that is the intended answer.
    notFound();
  }
  const { card, refs, events, has_more: hasMore } = parsed.data;

  // The feed is read under the same session, so a memory this reader may not
  // open never arrives — there is nothing to hide, unlike an attachment.
  const { data: feedData } = await supabase.rpc('card_feed', {
    p_card_id: id,
    p_limit: FEED_LIMIT,
  });
  const feed = cardFeedSchema.safeParse(feedData ?? {});
  const feedItems: LinkedMemoryItem[] = (
    feed.success ? feed.data.feed : []
  ).map((item) => ({
    type: kindLabel(item.kind, t),
    href: `/memory/${item.memory_id}`,
    preview: item.preview,
  }));
  const feedHasMore = feed.success && feed.data.has_more;

  const badges: BadgeListItem[] = [
    {
      label: cardStateLabel(card.state, t),
      variant: cardStateVariant(card.state),
      testId: 'card-state',
    },
    ...(card.archived_at
      ? [{ label: t('board.archived'), variant: 'secondary' as const }]
      : []),
    { label: scopeLabel(card.scope), variant: 'outline' as const },
  ];

  // An attachment whose target this reader may not open keeps its place in the
  // list and loses its content — the same treatment a hidden memory link gets.
  const refItems: LinkedMemoryItem[] = refs.map((ref) => {
    const href = cardRefHref(ref);
    return {
      type: ref.kind,
      ...(href !== undefined && ref.available
        ? { href, preview: ref.preview ?? ref.target }
        : {}),
    };
  });

  const entries: CardHistoryEntry[] = events.map((event) => ({
    id: event.id,
    seqLabel: String(event.seq),
    typeLabel: cardEventLabel(event.type, t),
    transitionLabel:
      event.from_state && event.to_state
        ? `${cardStateLabel(event.from_state, t)} → ${cardStateLabel(
            event.to_state,
            t
          )}`
        : undefined,
    actorLabel: event.agent_label ?? event.actor_id,
    timeLabel: formatTimestamp(event.created_at),
    reason: event.reason ?? undefined,
    note: event.text
      ? {
          text: event.text,
          relationLabel: event.relation
            ? cardRelationLabel(event.relation, t)
            : undefined,
        }
      : undefined,
    refLabel:
      event.ref_kind && event.ref_target
        ? `${event.ref_kind}: ${event.ref_target}`
        : undefined,
  }));

  return (
    <div className="flex flex-col gap-6" data-testid="card-detail">
      {variant === 'page' ? (
        <Link
          href="/board"
          className="text-muted-foreground hover:text-foreground w-fit text-sm"
        >
          ← {t('board.back')}
        </Link>
      ) : null}

      <header className="flex flex-col gap-2">
        <div className="flex flex-wrap items-baseline gap-2">
          <span className="text-muted-foreground text-sm tabular-nums">
            #{card.number}
          </span>
          <h1 className="text-2xl font-semibold" data-testid="card-title">
            {card.title}
          </h1>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <BadgeList badges={badges} />
          <span className="text-muted-foreground text-xs">
            {t('board.updated')} {formatTimestamp(card.updated_at)}
          </span>
        </div>
        {/* Where the work came from, when it began as a handover. The loop
            itself stays in history: promoting is not finishing. */}
        {card.origin_loop_id ? (
          <p className="text-muted-foreground text-xs">
            {t('board.fromLoop')}{' '}
            <Link
              href={`/memory/${card.origin_loop_id}`}
              className="hover:text-foreground underline underline-offset-2"
            >
              {card.origin_loop_id}
            </Link>
          </p>
        ) : null}
      </header>

      {card.body.trim() !== '' ? (
        <Card>
          <CardContent className="p-4">
            <Markdown
              data-testid="card-body"
              linkComponent={Link}
              imageLabel={t('markdown.image')}
            >
              {card.body}
            </Markdown>
          </CardContent>
        </Card>
      ) : null}

      <DetailSection title={t('board.refs')} data-testid="card-refs">
        {refItems.length === 0 ? (
          <EmptyState compact>{t('board.noRefs')}</EmptyState>
        ) : (
          <LinkedMemoryList
            items={refItems}
            hiddenLabel={t('board.refHidden')}
            linkComponent={Link}
          />
        )}
      </DetailSection>

      <DetailSection title={t('board.feed')} data-testid="card-feed">
        {feedItems.length === 0 ? (
          <EmptyState compact>{t('board.noFeed')}</EmptyState>
        ) : (
          <LinkedMemoryList
            items={feedItems}
            hiddenLabel={t('board.refHidden')}
            linkComponent={Link}
          />
        )}
        {feedHasMore ? (
          <p className="text-muted-foreground mt-3 text-xs">
            {t('board.moreFeed')}
          </p>
        ) : null}
      </DetailSection>

      <DetailSection title={t('board.history')}>
        <CardHistory
          entries={entries}
          emptyLabel={t('board.noHistory')}
          linkComponent={Link}
        />
        {hasMore ? (
          <p className="text-muted-foreground mt-3 text-xs">
            {t('board.moreHistory')}
          </p>
        ) : null}
      </DetailSection>

      {variant === 'page' ? <BoardLive /> : null}
    </div>
  );
}
