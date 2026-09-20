import Link from 'next/link';

import { Alert, AlertDescription } from '@workspace/ui/components/alert';
import {
  BoardColumns,
  type BoardColumn,
} from '@workspace/ui/components/board/board-columns';

import { BoardFilter } from '@/components/board-filter.client';
import { BoardLive } from '@/components/board-live.client';
import {
  ALL_BOARDS,
  CARD_STATES,
  boardListSchema,
  boardScopesSchema,
  cardEventLabel,
  cardStateLabel,
  cardStateVariant,
  resolveBoardScope,
  type BoardCard,
} from '@/lib/board';
import { scopeSlug } from '@workspace/ui/lib/scope-format';

import { getRequestMessages } from '@/lib/i18n';
import { formatTimestamp, scopeLabel } from '@/lib/memory';
import { createServerSupabaseClient } from '@/lib/supabase/server';

/** Cards fetched per view. A board past this is a board nobody reads. */
const BOARD_LIMIT = 200;

/** How much of the move's reason a column tile shows before the card page. */
const REASON_CHARS = 120;

export default async function BoardPage({
  searchParams,
}: {
  searchParams: Promise<{ scope?: string }>;
}) {
  const { scope } = await searchParams;
  const { t } = await getRequestMessages();

  const supabase = await createServerSupabaseClient();

  // Which boards exist at all, newest activity first. The answer decides both
  // the picker's options and, with no choice in the address, which board opens.
  const { data: scopeRows } = await supabase.rpc('board_scopes');
  const boards = boardScopesSchema.safeParse(scopeRows).data ?? [];
  const { selected, value } = resolveBoardScope(scope, boards);

  const { data, error } = await supabase.rpc('board_list', {
    p_scope: selected ?? undefined,
    p_limit: BOARD_LIMIT,
  });

  const parsed = data ? boardListSchema.safeParse(data) : null;
  const board = parsed?.success ? parsed.data : { cards: [], totals: {} };

  const byState = new Map<string, BoardCard[]>(
    CARD_STATES.map((state) => [state, []])
  );
  for (const card of board.cards) {
    byState.get(card.state)?.push(card);
  }

  const columns: BoardColumn[] = CARD_STATES.map((state) => ({
    key: state,
    label: cardStateLabel(state, t),
    variant: cardStateVariant(state),
    cards: (byState.get(state) ?? []).map((card) => ({
      id: card.id,
      href: `/board/${card.id}`,
      numberLabel: `#${card.number}`,
      title: card.title,
      badges: [
        { label: scopeLabel(card.scope), variant: 'outline' as const },
        ...(card.refs > 0
          ? [
              {
                label: t('board.refsCount', { count: card.refs }),
                variant: 'ghost' as const,
              },
            ]
          : []),
      ],
      // The last thing that happened, with the reason its author gave — the
      // whole point of a column at a glance.
      lastEventLabel: card.last_event
        ? `${cardEventLabel(card.last_event.type, t)} · ${formatTimestamp(
            card.last_event.created_at
          )}`
        : undefined,
      reason: card.state_reason?.slice(0, REASON_CHARS),
    })),
  }));

  return (
    <div className="flex flex-col gap-6 p-4" data-testid="board">
      <div className="flex flex-col gap-1">
        {/* The picker rides on the title's line, right-aligned: it is a label
            for what is on screen rather than a form, so it costs a row of its
            own for nothing. Always present — hiding it with one board, or
            with an empty one, would leave the reader unable to see which
            board they are looking at. An empty board filters to empty. */}
        <div className="flex items-center justify-between gap-4">
          <h1 className="text-2xl font-semibold">{t('board.title')}</h1>
          <BoardFilter
            testId="board-scope-filter"
            placeholder={
              // The default row names the board it resolves to, so "opened on
              // the latest activity" is visible rather than merely true.
              value === '' && selected
                ? t('board.scope.latestNamed', { scope: scopeSlug(selected) })
                : t('board.scope.latest')
            }
            value={value}
            options={[
              { value: ALL_BOARDS, label: t('board.scope.all') },
              ...boards.map((board) => ({
                value: board.scope,
                label: scopeSlug(board.scope),
                count: board.cards,
              })),
              // A board named in the address but holding nothing is still the
              // board on screen, so the control says so instead of going blank.
              ...(value !== '' &&
              value !== ALL_BOARDS &&
              !boards.some((board) => board.scope === value)
                ? [{ value, label: scopeSlug(value), count: 0 }]
                : []),
            ]}
          />
        </div>
        <p className="text-muted-foreground text-sm">
          {t('board.description')}
        </p>
      </div>

      {error ? (
        <Alert variant="destructive">
          <AlertDescription>{t('board.loadError')}</AlertDescription>
        </Alert>
      ) : null}

      <BoardColumns
        columns={columns}
        emptyLabel={t('board.empty')}
        linkComponent={Link}
      />

      <BoardLive />
    </div>
  );
}
