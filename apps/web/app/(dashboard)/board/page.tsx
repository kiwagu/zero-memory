import Link from 'next/link';

import { Alert, AlertDescription } from '@workspace/ui/components/alert';
import { InfoHint } from '@workspace/ui/components/common/info-hint';
import { BoardCardList } from '@workspace/ui/components/board/board-card-list';
import {
  BoardColumns,
  type BoardColumn,
  type BoardColumnCard,
} from '@workspace/ui/components/board/board-columns';
import {
  BoardContinuation,
  type BoardContinuationItem,
} from '@workspace/ui/components/board/board-continuation';

import { BoardFilter } from '@/components/board-filter.client';
import { BoardSearch } from '@/components/board-search.client';
import { BoardLive } from '@/components/board-live.client';
import { BoardMineToggle } from '@/components/board-mine-toggle.client';
import {
  ALL_BOARDS,
  CARD_STATES,
  boardContinuationsSchema,
  boardListSchema,
  boardScopesSchema,
  cardEventLabel,
  cardLabel,
  cardStateLabel,
  cardStateVariant,
  releasePolicyLabel,
  releaseSettingsSchema,
  resolveBoardScope,
  workStepLabel,
  type BoardCard,
} from '@/lib/board';
import { scopeOptionLabel } from '@workspace/ui/lib/scope-format';

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
  searchParams: Promise<{ scope?: string; q?: string; mine?: string }>;
}) {
  const { scope, q, mine: mineParam } = await searchParams;
  // The cards I worked on, newest own work first, instead of the columns.
  const mine = mineParam === '1';
  // A label (ZM-42, #42, 42) or a piece of a title; the store decides which.
  const query = q?.trim() ?? '';
  const { t } = await getRequestMessages();

  const supabase = await createServerSupabaseClient();

  // Which boards exist at all, newest activity first. The answer decides both
  // the picker's options and, with no choice in the address, which board opens.
  const { data: scopeRows } = await supabase.rpc('board_scopes');
  const boards = boardScopesSchema.safeParse(scopeRows).data ?? [];
  const { selected, value } = resolveBoardScope(scope, boards);

  // A board wears the name its owner gave the scope, exactly as the memory
  // feed and the rules groups do — one rule, so the same project reads the
  // same way wherever it is offered.
  const { data: aliasRows } = boards.length
    ? await supabase
        .from('scopes')
        .select('scope, alias')
        .in(
          'scope',
          boards.map((board) => board.scope)
        )
    : { data: [] };
  const aliasByScope = new Map(
    (aliasRows ?? []).map((row) => [String(row.scope), row.alias])
  );

  // The release setting is read-only here: it is edited through the MCP
  // `release` tool's `configure` action, never from the dashboard. It only
  // applies to one selected board — "all boards" has no single setting to
  // show. Started alongside board_list (Promise.all) so a single-board page
  // load does not wait one more round trip for it.
  const releaseQuery =
    selected && selected !== ALL_BOARDS
      ? supabase.rpc('release_settings', { p_scope: selected })
      : Promise.resolve({ data: null });

  // The Mine view reads what a new session would be offered, for this board
  // or, with every board on screen, for each of them.
  const continuationQuery = mine
    ? supabase.rpc('board_continuation', { p_scope: selected ?? undefined })
    : Promise.resolve({ data: null, error: null });

  const [
    { data: releaseData },
    { data, error },
    { data: continuationData, error: continuationError },
  ] = await Promise.all([
    releaseQuery,
    supabase.rpc('board_list', {
      p_scope: selected ?? undefined,
      p_query: query || undefined,
      p_limit: BOARD_LIMIT,
      p_worked_by_me: mine,
    }),
    continuationQuery,
  ]);
  const continuations = mine
    ? boardContinuationsSchema.safeParse(continuationData)
    : null;
  const releaseParsed = releaseSettingsSchema.safeParse(
    (releaseData as { settings?: unknown } | null)?.settings
  );
  const release = releaseParsed.success ? releaseParsed.data : null;

  const parsed = data ? boardListSchema.safeParse(data) : null;
  const board = parsed?.success ? parsed.data : { cards: [], totals: {} };

  const byState = new Map<string, BoardCard[]>(
    CARD_STATES.map((state) => [state, []])
  );
  for (const card of board.cards) {
    byState.get(card.state)?.push(card);
  }

  // What every tile says about its card, in the columns and in Mine alike.
  const commonBadges = (card: BoardCard) => [
    { label: scopeLabel(card.scope), variant: 'outline' as const },
    ...(card.released_in
      ? [
          {
            label: t('board.releasedIn', { version: card.released_in }),
            variant: 'green' as const,
          },
        ]
      : []),
    ...(card.blocked
      ? [
          {
            label: t('board.blocked'),
            variant: 'destructive' as const,
            testId: 'board-card-blocked',
          },
        ]
      : []),
    ...(card.refs > 0
      ? [
          {
            label: t('board.refsCount', { count: card.refs }),
            variant: 'ghost' as const,
          },
        ]
      : []),
  ];

  const columns: BoardColumn[] = CARD_STATES.map((state) => ({
    key: state,
    label: cardStateLabel(state, t),
    variant: cardStateVariant(state),
    cards: (byState.get(state) ?? []).map((card) => ({
      id: card.id,
      href: `/board/${card.id}`,
      numberLabel: cardLabel(card.number),
      title: card.title,
      badges: commonBadges(card),
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

  // In the Mine view a tile names the column it would sit in, and its event
  // line is YOUR latest step, not whatever touched the card last.
  const mineTiles: BoardColumnCard[] = board.cards.map((card) => ({
    id: card.id,
    href: `/board/${card.id}`,
    numberLabel: cardLabel(card.number),
    title: card.title,
    badges: [
      {
        label: cardStateLabel(card.state, t),
        variant: cardStateVariant(card.state),
        testId: 'board-card-state',
      },
      ...commonBadges(card),
      ...(card.past_horizon
        ? [
            {
              label: t('board.mine.pastHorizon'),
              variant: 'ghost' as const,
              testId: 'board-card-past-horizon',
            },
          ]
        : []),
    ],
    lastEventLabel: card.my_last
      ? t('board.mine.myStep', {
          step: workStepLabel(card.my_last, t),
          at: formatTimestamp(card.my_last.created_at),
        })
      : undefined,
    reason: card.my_last?.text?.slice(0, REASON_CHARS) ?? undefined,
  }));

  const continuationItems: BoardContinuationItem[] = (
    continuations?.success ? continuations.data.boards : []
  ).map(({ scope: boardScope, continuation }) => {
    const offered = continuation.card;
    const last = continuation.last[0];
    return {
      key: boardScope,
      // Every board on screen: each offer says which board it is for.
      scopeLabel:
        value === ALL_BOARDS
          ? scopeOptionLabel(boardScope, aliasByScope.get(boardScope))
          : undefined,
      ...(offered
        ? {
            href: `/board/${offered.id}`,
            numberLabel: cardLabel(offered.number),
            title: offered.title,
            stateLabel: cardStateLabel(offered.state, t),
            stateVariant: cardStateVariant(offered.state),
            reason: offered.state_reason?.slice(0, REASON_CHARS) ?? undefined,
            lastStepLabel: last
              ? t('board.mine.myStep', {
                  step: workStepLabel(last, t),
                  at: formatTimestamp(last.created_at),
                })
              : undefined,
            lastStepText: last?.text ?? undefined,
          }
        : {}),
      lastSessionLabel: continuation.last_session
        ? t('board.mine.lastSession', {
            label: cardLabel(continuation.last_session.number),
            step: workStepLabel(continuation.last_session, t),
          })
        : undefined,
    };
  });
  // A reply that cannot be read is an error on screen, never an empty offer.
  const mineError =
    mine && (continuationError !== null || !continuations?.success);

  return (
    <div className="flex flex-col gap-6 p-4" data-testid="board">
      <div className="flex flex-col gap-1">
        {/* The picker rides on the title's line, right-aligned: it is a label
            for what is on screen rather than a form, so it costs a row of its
            own for nothing. Always present — hiding it with one board, or
            with an empty one, would leave the reader unable to see which
            board they are looking at. An empty board filters to empty. The
            filter beside it narrows the cards by label or title and lives in
            the address with the board; nothing matching shows as nothing. */}
        <div className="flex items-center justify-between gap-4">
          {/* What the board is, and where its production state comes from, are
              read once rather than on every visit: they sit in a hint beside
              the title instead of taking rows above the columns. */}
          <div className="flex items-center gap-1">
            <h1 className="text-2xl font-semibold">{t('board.title')}</h1>
            <InfoHint label={t('board.about')} testId="board-hint">
              <p>{t('board.description')}</p>
              {release ? (
                <p data-testid="board-release-settings">
                  {t('board.release.settings', {
                    source:
                      release.version_url ??
                      t('board.release.tagsOnly', {
                        template: release.tag_template,
                      }),
                    policy: releasePolicyLabel(release.on_release, t),
                  })}
                </p>
              ) : null}
            </InfoHint>
          </div>
          <div className="flex flex-wrap items-center justify-end gap-2">
            <BoardMineToggle checked={mine} label={t('board.mine.toggle')} />
            <BoardSearch
              value={query}
              placeholder={t('board.search.placeholder')}
              submitLabel={t('board.search.submit')}
            />
            <BoardFilter
              testId="board-scope-filter"
              placeholder={
                // The default row names the board it resolves to, so "opened on
                // the latest activity" is visible rather than merely true.
                value === '' && selected
                  ? t('board.scope.latestNamed', {
                      scope: scopeOptionLabel(
                        selected,
                        aliasByScope.get(selected)
                      ),
                    })
                  : t('board.scope.latest')
              }
              value={value}
              options={[
                { value: ALL_BOARDS, label: t('board.scope.all') },
                ...boards.map((board) => ({
                  value: board.scope,
                  label: scopeOptionLabel(
                    board.scope,
                    aliasByScope.get(board.scope)
                  ),
                  count: board.cards,
                })),
                // A board named in the address but holding nothing is still the
                // board on screen, so the control says so instead of going blank.
                ...(value !== '' &&
                value !== ALL_BOARDS &&
                !boards.some((board) => board.scope === value)
                  ? [{ value, label: scopeOptionLabel(value), count: 0 }]
                  : []),
              ]}
            />
          </div>
        </div>
      </div>

      {error || mineError ? (
        <Alert variant="destructive">
          <AlertDescription>{t('board.loadError')}</AlertDescription>
        </Alert>
      ) : null}

      {mine ? (
        <>
          <BoardContinuation
            heading={t('board.mine.continue')}
            items={continuationItems}
            emptyLabel={t('board.mine.nothingOffered', {
              days: continuations?.success
                ? continuations.data.horizon_days
                : 0,
            })}
            linkComponent={Link}
          />
          <BoardCardList
            cards={mineTiles}
            emptyLabel={t('board.mine.empty')}
            linkComponent={Link}
          />
        </>
      ) : (
        <BoardColumns
          columns={columns}
          emptyLabel={t('board.empty')}
          linkComponent={Link}
        />
      )}

      {/* One board on screen listens to that board; every board on screen
          listens to each of them. */}
      <BoardLive
        scopes={selected ? [selected] : boards.map((board) => board.scope)}
      />
    </div>
  );
}
