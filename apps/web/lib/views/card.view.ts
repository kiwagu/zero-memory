import type { CardBranchItem } from '@workspace/ui/components/board/card-branches';
import type { CardHistoryEntry } from '@workspace/ui/components/board/card-history';
import type { CardLinkGroup } from '@workspace/ui/components/board/card-links';
import type { CardDetailData } from '@workspace/ui/components/board/card-detail';
import type { BadgeListItem } from '@workspace/ui/components/common/badge-list';
import type { LinkedMemoryItem } from '@workspace/ui/components/memory/linked-memory-list';
import { cardLabelNumbers } from '@workspace/ui/lib/markdown';
import { scopeSlug } from '@workspace/ui/lib/scope-format';

import {
  cardBranchEarlierLabel,
  cardBranchStateLabel,
  cardEventLabel,
  cardEventLinkRelation,
  cardLabel,
  cardLinkRelationLabel,
  cardRefHref,
  cardRelationLabel,
  cardStateLabel,
  cardFeedSchema,
  cardStateVariant,
  cardViewSchema,
  type CardLink,
  type CardLinkRelation,
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
/**
 * Distinct card labels resolved per view. A text naming more cards than this
 * keeps the rest as plain labels; the request stays bounded.
 */
const MENTION_LIMIT = 100;

/**
 * The sides a relation can sit on, in reading order, each with the relations
 * it holds as the card names them. Above is the parent and the secondary
 * parents — what blocks the card and what it depends on.
 */
const LINK_SIDES: ReadonlyArray<{
  key: 'above' | 'below' | 'related' | 'duplicates';
  relations: readonly CardLinkRelation[];
}> = [
  { key: 'above', relations: ['child_of', 'blocked_by', 'depends_on'] },
  { key: 'below', relations: ['parent_of', 'blocks', 'needed_by'] },
  { key: 'related', relations: ['relates_to'] },
  { key: 'duplicates', relations: ['duplicates', 'duplicated_by'] },
];

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
  const {
    card,
    refs,
    branches,
    releases,
    events,
    has_more: hasMore,
    links,
    blocked,
  } = parsed.data;

  // A `ZM-N` label in the card's text means card N of THIS card's board. It
  // is resolved under the reader's session, so a card the reader may not see
  // never arrives and its label stays text, like a label naming no card. The
  // card's own label is left as text: it would only open the card again.
  const mentioned = cardLabelNumbers([
    card.body,
    ...events.flatMap((event) => [event.reason ?? '', event.text ?? '']),
  ])
    .filter((number) => number !== card.number)
    .slice(0, MENTION_LIMIT);

  // The feed is read under the same session, so a memory this reader may not
  // open never arrives — there is nothing to hide, unlike an attachment.
  const [feedResult, mentionResult] = await Promise.all([
    supabase.rpc('card_feed', {
      p_card_id: id,
      p_limit: FEED_LIMIT,
    }),
    mentioned.length > 0
      ? supabase
          .from('cards')
          .select('id, number')
          .eq('scope', card.scope)
          .in('number', mentioned)
      : Promise.resolve({ data: [], error: null }),
  ]);
  const feedData = rowsOf(feedResult, 'card feed');
  const cardLinks: Record<string, string> = Object.fromEntries(
    (rowsOf(mentionResult, 'card mentions') ?? []).map((row) => [
      String(row.number),
      `/board/${row.id}`,
    ])
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

  // Newest first: the latest production state that carried the card, when
  // one does.
  const [latestRelease] = releases;

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
    ...(latestRelease
      ? [
          {
            label: t('board.releasedIn', { version: latestRelease.version }),
            variant: 'green' as const,
          },
        ]
      : []),
    ...(blocked
      ? [
          {
            label: t('board.blocked'),
            variant: 'destructive' as const,
            testId: 'card-blocked',
          },
        ]
      : []),
  ];

  const sideLabel = (key: (typeof LINK_SIDES)[number]['key']): string => {
    switch (key) {
      case 'above':
        return t('board.links.above');
      case 'below':
        return t('board.links.below');
      case 'related':
        return t('board.links.related');
      case 'duplicates':
        return t('board.links.duplicates');
    }
  };
  const linkItem = (link: CardLink) => ({
    key: `${link.relation}:${link.card_id}`,
    href: `/board/${link.card_id}`,
    relationLabel: cardLinkRelationLabel(link.relation, t),
    numberLabel: cardLabel(link.number),
    title: link.title,
    stateLabel: cardStateLabel(link.state, t),
    stateVariant: cardStateVariant(link.state),
    reason: link.reason,
    ...(link.declared ? {} : { undeclaredLabel: t('board.linkUndeclared') }),
    // A number alone names a card of this board; one on another board says
    // which.
    ...(link.scope === card.scope ? {} : { boardLabel: scopeSlug(link.scope) }),
    ...(link.archived ? { archivedLabel: t('board.archived') } : {}),
  });
  // Within a side, relations keep the side's order (a parent before what
  // blocks the card), then the order the store sends.
  const linkGroups: CardLinkGroup[] = LINK_SIDES.map((side) => ({
    key: side.key,
    label: sideLabel(side.key),
    items: side.relations.flatMap((relation) =>
      links.filter((link) => link.relation === relation).map(linkItem)
    ),
  }));

  // An attachment whose target this reader may not open keeps its place in the
  // list and loses its content — the same treatment a hidden memory link gets.
  // An attached memory is named by its kind — a decision reads as one — and
  // attachments of one kind sit together.
  const refItems: LinkedMemoryItem[] = refs
    .map((ref) => {
      const href = cardRefHref(ref);
      return {
        type:
          ref.kind === 'memory' && ref.memory_kind
            ? kindLabel(ref.memory_kind, t)
            : ref.kind,
        ...(href !== undefined && ref.available
          ? { href, preview: ref.preview ?? ref.target }
          : {}),
      };
    })
    .sort((a, b) => a.type.localeCompare(b.type));

  const branchItems: CardBranchItem[] = branches.map((branch) => ({
    key: `${branch.repo}:${branch.branch}`,
    name: branch.branch,
    repo: branch.repo,
    stateLabel: cardBranchStateLabel(branch, t),
    earlierLabel: cardBranchEarlierLabel(branch, t),
    landed: branch.state === 'landed',
  }));

  const entries: CardHistoryEntry[] = events.map((event) => {
    const linkRelation = cardEventLinkRelation(event);
    return {
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
      declarations: [
        ...(event.branch_note
          ? [{ label: t('board.declaration'), text: event.branch_note }]
          : []),
        ...(event.links_note
          ? [{ label: t('board.linksDeclaration'), text: event.links_note }]
          : []),
      ],
      note: event.text
        ? {
            text: event.text,
            relationLabel: event.relation
              ? cardRelationLabel(event.relation, t)
              : undefined,
          }
        : undefined,
      refLabel:
        (event.type === 'linked' || event.type === 'unlinked') && linkRelation
          ? `${cardLinkRelationLabel(linkRelation, t)} ${
              event.ref_number !== null
                ? cardLabel(event.ref_number)
                : (event.ref_target ?? '')
            }`
          : event.type === 'landed' && event.ref_target
            ? `${event.ref_target} → ${event.target_branch ?? ''} (${(
                event.squash_sha ?? ''
              ).slice(0, 7)})`
            : event.type === 'released' && event.release_version
              ? `v${event.release_version}${
                  event.release_build ? ` (build ${event.release_build})` : ''
                }`
              : event.ref_kind && event.ref_target
                ? `${event.ref_kind}: ${event.ref_target}`
                : undefined,
    };
  });

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
      links: {
        title: t('board.links'),
        groups: linkGroups,
        emptyLabel: t('board.noLinks'),
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
      cardLinks,
    },
  };
}
