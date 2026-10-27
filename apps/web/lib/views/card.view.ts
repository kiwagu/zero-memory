import { cardFeedSchema, cardViewSchema } from '@/lib/board';
import { getRequestMessages } from '@/lib/i18n';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import {
  cardMentionNumbers,
  toCardViewData,
  type CardViewData,
} from '@/lib/views/card.mapper';
import { rowsOf } from '@/lib/views/query';

/**
 * One card as its view needs it — loaded once, under the viewer's session,
 * and rendered by the card's page, the dialog over the board, or a panel of
 * the chain. The mapping to view data is `card.mapper.ts`.
 */

/** Events fetched per view. */
const HISTORY_LIMIT = 200;
/** The newest feed entries shown on a card; older ones stay reachable by MCP. */
const FEED_LIMIT = 50;

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
  const view = parsed.data;

  // Mentioned cards are resolved under the reader's session, so a card the
  // reader may not see never arrives.
  const mentioned = cardMentionNumbers(view);
  const [feedResult, mentionResult] = await Promise.all([
    supabase.rpc('card_feed', {
      p_card_id: id,
      p_limit: FEED_LIMIT,
    }),
    mentioned.length > 0
      ? supabase
          .from('cards')
          .select('id, number')
          .eq('scope', view.card.scope)
          .in('number', mentioned)
      : Promise.resolve({ data: [], error: null }),
  ]);
  const feed = cardFeedSchema.safeParse(rowsOf(feedResult, 'card feed') ?? {});

  return toCardViewData(
    view,
    {
      feed: feed.success ? feed.data : null,
      mentions: rowsOf(mentionResult, 'card mentions') ?? [],
    },
    t
  );
}
