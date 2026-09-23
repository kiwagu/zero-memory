import type { CardBranchItem } from '@workspace/ui/components/board/card-branches';
import type { CardHistoryEntry } from '@workspace/ui/components/board/card-history';
import type { CardDetailData } from '@workspace/ui/components/board/card-detail';
import type { BadgeListItem } from '@workspace/ui/components/common/badge-list';
import type { LinkedMemoryItem } from '@workspace/ui/components/memory/linked-memory-list';

import {
  cardBranchEarlierLabel,
  cardBranchStateLabel,
  cardEventLabel,
  cardLabel,
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
import { rowsOf } from '@/lib/views/query';

/**
 * One card as its view needs it — loaded once, under the viewer's session,
 * and rendered by the card's page, the dialog over the board, or a panel of
 * the chain. Everything is serializable: a panel receives it as JSON.
 */

/** Events fetched per view. */
const HISTORY_LIMIT = 200;
/** The newest feed entries shown on a card; older ones stay reachable by MCP. */
const FEED_LIMIT = 50;

export interface CardViewData {
  id: string;
  /** `ZM-<number> <title>` — what names the card in a panel. */
  title: string;
  detail: CardDetailData;
}

export async function loadCardView(id: string): Promise<CardViewData | null> {
  const { t } = await getRequestMessages();

  const supabase = await createServerSupabaseClient();
  const data = rowsOf(
    await supabase.rpc('card_get', {
      p_card_id: id,
      p_limit: HISTORY_LIMIT,
    }),
    'card'
  );

  const parsed = data ? cardViewSchema.safeParse(data) : null;
  if (!parsed?.success) {
    // A card outside the reader's scopes is indistinguishable from one that
    // does not exist, and that is the intended answer.
    return null;
  }
  const { card, refs, branches, events, has_more: hasMore } = parsed.data;

  // The feed is read under the same session, so a memory this reader may not
  // open never arrives — there is nothing to hide, unlike an attachment.
  const feedData = rowsOf(
    await supabase.rpc('card_feed', {
      p_card_id: id,
      p_limit: FEED_LIMIT,
    }),
    'card feed'
  );
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

  const branchItems: CardBranchItem[] = branches.map((branch) => ({
    key: `${branch.repo}:${branch.branch}`,
    name: branch.branch,
    repo: branch.repo,
    stateLabel: cardBranchStateLabel(branch, t),
    earlierLabel: cardBranchEarlierLabel(branch, t),
    landed: branch.state === 'landed',
  }));

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
    declaration: event.branch_note
      ? { label: t('board.declaration'), text: event.branch_note }
      : undefined,
    note: event.text
      ? {
          text: event.text,
          relationLabel: event.relation
            ? cardRelationLabel(event.relation, t)
            : undefined,
        }
      : undefined,
    refLabel:
      event.type === 'landed' && event.ref_target
        ? `${event.ref_target} → ${event.target_branch ?? ''} (${(
            event.squash_sha ?? ''
          ).slice(0, 7)})`
        : event.ref_kind && event.ref_target
          ? `${event.ref_kind}: ${event.ref_target}`
          : undefined,
  }));

  return {
    id: card.id,
    title: `${cardLabel(card.number)} ${card.title}`,
    detail: {
      numberLabel: cardLabel(card.number),
      link: {
        href: `/board/${card.id}`,
        copyHint: t('board.copyLink'),
        copiedLabel: t('board.linkCopied'),
      },
      title: card.title,
      badges,
      updatedLabel: `${t('board.updated')} ${formatTimestamp(card.updated_at)}`,
      originLoop: card.origin_loop_id
        ? {
            label: t('board.fromLoop'),
            id: card.origin_loop_id,
            href: `/memory/${card.origin_loop_id}`,
          }
        : null,
      body: card.body,
      branches: {
        title: t('board.branches'),
        items: branchItems,
        emptyLabel: t('board.noBranches'),
      },
      refs: {
        title: t('board.refs'),
        items: refItems,
        emptyLabel: t('board.noRefs'),
      },
      feed: {
        title: t('board.feed'),
        items: feedItems,
        emptyLabel: t('board.noFeed'),
        moreLabel: feedHasMore ? t('board.moreFeed') : null,
      },
      history: {
        title: t('board.history'),
        entries,
        emptyLabel: t('board.noHistory'),
        moreLabel: hasMore ? t('board.moreHistory') : null,
      },
      hiddenLabel: t('board.refHidden'),
      imageLabel: t('markdown.image'),
    },
  };
}
