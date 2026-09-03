import Link from 'next/link';

import { Alert, AlertDescription } from '@workspace/ui/components/alert';
import {
  ActivityLog,
  type ActivityLogItem,
} from '@workspace/ui/components/dashboard/activity-log';
import { FeedPagination } from '@workspace/ui/components/memory/feed-pagination';
import { cn } from '@workspace/ui/lib/utils';

import { getRequestMessages } from '@/lib/i18n';
import { activityResultSchema, type ActivityEvent } from '@/lib/insights';
import { PAGE_SIZE, formatTimestamp, kindLabel } from '@/lib/memory';
import { createServerSupabaseClient } from '@/lib/supabase/server';

const FILTERS = ['all', 'hits', 'empty', 'errors'] as const;
type Filter = (typeof FILTERS)[number];

/** Page filter → the RPC's p_outcome value. */
const FILTER_OUTCOME: Record<Filter, 'all' | 'hit' | 'empty' | 'error'> = {
  all: 'all',
  hits: 'hit',
  empty: 'empty',
  errors: 'error',
};

function resolveFilter(raw: string | undefined): Filter {
  return (FILTERS as readonly string[]).includes(raw ?? '')
    ? (raw as Filter)
    : 'all';
}

/** Facts a row shows before the "+N more" disclosure holds back the rest. */
const FACTS_PORTION = 8;

function pageHref(filter: Filter, page: number): string {
  const query = new URLSearchParams();
  if (filter !== 'all') query.set('f', filter);
  if (page > 1) query.set('page', String(page));
  const encoded = query.toString();
  return encoded ? `/activity?${encoded}` : '/activity';
}

/** Stable per-actor dot color: same actor → same chart token, every render. */
const DOT_CLASSES = [
  'bg-chart-1',
  'bg-chart-2',
  'bg-chart-3',
  'bg-chart-4',
  'bg-chart-5',
] as const;

function dotClass(actor: string): string {
  let hash = 0;
  for (const char of actor) {
    hash = (hash * 31 + char.codePointAt(0)!) >>> 0;
  }
  return DOT_CLASSES[hash % DOT_CLASSES.length]!;
}

export default async function ActivityPage({
  searchParams,
}: {
  searchParams: Promise<{
    f?: string;
    page?: string;
  }>;
}) {
  const { f, page: pageParam } = await searchParams;
  const filter = resolveFilter(f);
  const page = Math.max(1, Number.parseInt(pageParam ?? '1', 10) || 1);
  const { t } = await getRequestMessages();

  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.rpc('dashboard_activity', {
    p_days: 30,
    p_limit: PAGE_SIZE,
    p_offset: (page - 1) * PAGE_SIZE,
    p_outcome: FILTER_OUTCOME[filter],
  });

  const parsed = data ? activityResultSchema.safeParse(data) : null;
  const result = parsed?.success ? parsed.data : { total: 0, events: [] };
  const totalPages = Math.max(1, Math.ceil(result.total / PAGE_SIZE));

  const filterOptions = [
    { value: 'all', label: t('activity.filter.all') },
    { value: 'hits', label: t('activity.filter.hits') },
    { value: 'empty', label: t('activity.filter.empty') },
    { value: 'errors', label: t('activity.filter.errors') },
  ] as const;

  const toolLabel = (event: ActivityEvent): string => {
    if (event.tool === 'recall') return t('activity.tool.recall');
    if (event.tool === 'build_context') return t('activity.tool.buildContext');
    return event.tool;
  };

  const items: ActivityLogItem[] = result.events.map((event) => {
    const actor = event.agent_name ?? t('activity.you');
    // The row ships every fact it fetched: the first portion is visible, the
    // rest ride along behind a disclosure the reader opens in place. Revealing
    // them used to be a navigation, which re-rendered the whole feed and moved
    // the row out from under the reader.
    const visibleFacts = event.facts.slice(0, FACTS_PORTION);
    const restFacts = event.facts.slice(FACTS_PORTION);
    const hiddenCount = (event.returned ?? 0) - visibleFacts.length;
    return {
      id: event.id,
      actorLabel: actor,
      dotClassName: dotClass(actor),
      toolLabel: toolLabel(event),
      countLabel:
        event.returned !== null && event.returned > 0
          ? t('activity.returned', { count: event.returned })
          : undefined,
      outcome: event.error
        ? { label: t('activity.outcome.error'), variant: 'destructive' }
        : event.returned === null
          ? { label: t('activity.outcome.unknown'), variant: 'outline' }
          : event.returned > 0
            ? { label: t('activity.outcome.hit'), variant: 'green' }
            : { label: t('activity.outcome.empty'), variant: 'amber' },
      timeLabel: formatTimestamp(event.occurred_at),
      queryLabel: event.query ?? undefined,
      requestId: event.request_id ?? undefined,
      // The drill-down: owned facts link to their detail page with a preview;
      // a foreign (shared-scope) fact shows as a bare, non-navigable id.
      facts: visibleFacts.map((fact) => ({
        id: fact.id,
        label: fact.content ?? fact.id,
        href: fact.content !== null ? `/memory/${fact.id}` : undefined,
        kindLabel: fact.kind ? kindLabel(fact.kind, t) : undefined,
      })),
      // "+N more" only while fetched facts remain to reveal; a residue beyond
      // the RPC's fact cap is not offered, because nothing can show it.
      moreFacts:
        hiddenCount > 0 && restFacts.length > 0
          ? {
              label: t('activity.more', { count: hiddenCount }),
              facts: restFacts.map((fact) => ({
                id: fact.id,
                label: fact.content ?? fact.id,
                href: fact.content !== null ? `/memory/${fact.id}` : undefined,
                kindLabel: fact.kind ? kindLabel(fact.kind, t) : undefined,
              })),
            }
          : undefined,
    };
  });

  return (
    <div className="mx-auto max-w-3xl space-y-4" data-testid="activity-page">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="space-y-1">
          <h1 className="text-xl font-semibold">{t('activity.title')}</h1>
          <p className="text-muted-foreground text-sm">
            {t('activity.description')}
          </p>
        </div>
        <nav className="flex gap-1" aria-label={t('activity.title')}>
          {filterOptions.map((option) => (
            <Link
              key={option.value}
              href={pageHref(option.value, 1)}
              className={cn(
                'rounded-md px-3 py-1.5 text-sm',
                option.value === filter
                  ? 'bg-secondary text-secondary-foreground font-medium'
                  : 'text-muted-foreground hover:bg-secondary/50'
              )}
            >
              {option.label}
            </Link>
          ))}
        </nav>
      </div>

      {error ? (
        <Alert variant="destructive">
          <AlertDescription>
            {t('activity.loadError', { message: error.message })}
          </AlertDescription>
        </Alert>
      ) : null}

      {!error ? (
        <ActivityLog
          items={items}
          emptyLabel={t('activity.empty')}
          linkComponent={Link}
        />
      ) : null}

      {totalPages > 1 ? (
        <FeedPagination
          linkComponent={Link}
          newerHref={page > 1 ? pageHref(filter, page - 1) : undefined}
          olderHref={page < totalPages ? pageHref(filter, page + 1) : undefined}
          pageLabel={t('activity.pager.page', { page, total: totalPages })}
          newerLabel={t('activity.pager.prev')}
          olderLabel={t('activity.pager.next')}
        />
      ) : null}
    </div>
  );
}
