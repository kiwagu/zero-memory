import Link from 'next/link';
import { Suspense } from 'react';

import { Alert, AlertDescription } from '@workspace/ui/components/alert';
import { EmptyState } from '@workspace/ui/components/common/empty-state';
import { FeedPagination } from '@workspace/ui/components/memory/feed-pagination';
import { MemoryCard } from '@workspace/ui/components/memory/memory-card';
import { Skeleton } from '@workspace/ui/components/skeleton';

import { AdvancedSearch } from '@/components/advanced-search';
import { FeedFilters } from '@/components/feed-filters';
import { RankedResults } from '@/components/ranked-results';
import { RealtimeFeed } from '@/components/realtime-feed';
import { getRequestMessages } from '@/lib/i18n';
import { clampTopK, parseKindsParam } from '@/lib/recall';
import {
  DEFAULT_FEED_STATUS,
  FEED_STATUSES,
  MEMORY_COLUMNS,
  MEMORY_KINDS,
  PAGE_SIZE,
  VISIBILITIES,
  annotateFacetOptions,
  facetCount,
  facetCountIndex,
  facetTotal,
  feedStatusLabel,
  kindLabel,
  memoryCardProps,
  memoryIdSearchPrefix,
  parseFeedStatus,
  visibilityLabel,
  type FeedStatus,
  type MemoryRow,
} from '@/lib/memory';
import { scopeDisplay } from '@workspace/ui/lib/scope-format';

import { loadScopeMemberCounts } from '@/lib/scope-members';
import { createServerSupabaseClient } from '@/lib/supabase/server';

type SearchParams = Promise<{
  kind?: string;
  visibility?: string;
  q?: string;
  scope?: string;
  status?: string;
  page?: string;
  /** Ranked (semantic) search params — disjoint from the narrow filters. */
  search?: string;
  kinds?: string;
  sscope?: string;
  k?: string;
}>;

interface FeedFilterValues {
  kind?: string;
  visibility?: string;
  q?: string;
  scope?: string;
  status: FeedStatus;
}

/**
 * The feed's applied filters as a query string. The DEFAULT status stays out of
 * the URL, so a bare `/memories` link keeps meaning "the default view".
 */
function filterQuery(params: FeedFilterValues, page: number): URLSearchParams {
  const query = new URLSearchParams();
  if (params.kind) query.set('kind', params.kind);
  if (params.visibility) query.set('visibility', params.visibility);
  if (params.q) query.set('q', params.q);
  if (params.scope) query.set('scope', params.scope);
  if (params.status !== DEFAULT_FEED_STATUS) query.set('status', params.status);
  if (page > 1) query.set('page', String(page));
  return query;
}

function pageHref(params: FeedFilterValues, page: number): string {
  const encoded = filterQuery(params, page).toString();
  return encoded ? `/memories?${encoded}` : '/memories';
}

export default async function FeedPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const params = await searchParams;
  const kind = MEMORY_KINDS.find((value) => value === params.kind);
  const visibility = VISIBILITIES.find((value) => value === params.visibility);
  const q = params.q?.trim() ?? '';
  const status = parseFeedStatus(params.status);
  const page = Math.max(1, Number.parseInt(params.page ?? '1', 10) || 1);
  const offset = (page - 1) * PAGE_SIZE;
  const { messages, t } = await getRequestMessages();

  const supabase = await createServerSupabaseClient();

  // Project/scope filter options: the distinct scopes of the caller's memories
  // (RLS-scoped), excluding the personal scope. Only a handful of projects, so
  // they are offered by name.
  const { data: scopeRows } = await supabase.rpc('list_memory_scopes');
  // The display label prefers the scope's alias; the filter value stays the
  // raw path.
  const scopeOptions = (scopeRows ?? [])
    .filter((row) => !row.scope.startsWith('user.'))
    .map((row) => ({
      value: row.scope,
      label: row.alias ?? scopeDisplay(row.scope),
    }));
  const scope = scopeOptions.some((option) => option.value === params.scope)
    ? (params.scope as string)
    : '';

  // Facet availability: how many memories each filter value would yield under
  // the CURRENT selection, in one RLS-scoped roundtrip. Each facet is counted
  // with the other filters applied and its own ignored — otherwise picking a
  // kind would zero every other kind and there would be no way back.
  const idPrefix = q ? memoryIdSearchPrefix(q) : null;
  const { data: facetRows } = await supabase.rpc('feed_facet_counts', {
    p_kind: kind ?? undefined,
    p_visibility: visibility ?? undefined,
    p_scope: scope || undefined,
    p_status: status,
    p_q: idPrefix ? undefined : q || undefined,
    p_id_prefix: idPrefix ?? undefined,
  });
  const facetCounts = facetCountIndex(facetRows ?? []);

  const header = (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold">{t('feed.title')}</h1>
        <Suspense>
          <FeedFilters
            labels={{
              searchPlaceholder: t('feed.searchPlaceholder'),
              allKinds: t('feed.allKinds'),
              allVisibilities: t('feed.allVisibilities'),
              allScopes: t('feed.allScopes'),
              defaultStatus: feedStatusLabel(DEFAULT_FEED_STATUS, t),
              submit: t('feed.filter') + ' / ' + t('feed.refresh'),
              submitHint: t('feed.filterHint'),
            }}
            kinds={annotateFacetOptions(
              MEMORY_KINDS.map((value) => ({
                value: value as string,
                label: kindLabel(value, t),
              })),
              'kind',
              facetCounts,
              kind ?? ''
            )}
            visibilities={annotateFacetOptions(
              VISIBILITIES.map((value) => ({
                value: value as string,
                label: visibilityLabel(value, t),
              })),
              'visibility',
              facetCounts,
              visibility ?? ''
            )}
            scopes={annotateFacetOptions(
              scopeOptions,
              'scope',
              facetCounts,
              scope
            )}
            // The default is the select's placeholder row (it clears the param),
            // so only the non-default statuses are offered as values.
            statuses={annotateFacetOptions(
              FEED_STATUSES.filter(
                (value) => value !== DEFAULT_FEED_STATUS
              ).map((value) => ({
                value: value as string,
                label: feedStatusLabel(value, t),
              })),
              'status',
              facetCounts,
              status === DEFAULT_FEED_STATUS ? '' : status
            )}
            placeholderCounts={{
              kind: facetTotal(facetCounts, 'kind'),
              visibility: facetTotal(facetCounts, 'visibility'),
              scope: facetTotal(facetCounts, 'scope'),
              // The status placeholder IS a value (the default status), so it
              // carries that bucket's count instead of a sum of buckets that
              // overlap by construction.
              status: facetCount(facetCounts, 'status', DEFAULT_FEED_STATUS),
            }}
          />
        </Suspense>
      </div>
      <Suspense>
        <AdvancedSearch
          labels={{
            toggle: t('feed.advanced.toggle'),
            placeholder: t('feed.advanced.placeholder'),
            submit: t('feed.advanced.search'),
            allScopes: t('feed.allScopes'),
            topK: t('feed.advanced.topK'),
            clear: t('feed.advanced.clear'),
          }}
          kinds={MEMORY_KINDS.map((value) => ({
            value,
            label: kindLabel(value, t),
          }))}
          scopes={scopeOptions}
        />
      </Suspense>
    </>
  );

  // Ranked (semantic) mode: the query's presence switches the feed to the
  // recall-backed result list; the chronological query, realtime feed, and
  // pagination are bypassed entirely.
  const searchQuery = params.search?.trim() ?? '';
  if (searchQuery) {
    const searchKinds = parseKindsParam(params.kinds);
    const searchScope = scopeOptions.some(
      (option) => option.value === params.sscope
    )
      ? (params.sscope as string)
      : '';
    const topK = clampTopK(params.k);
    const searchKey = [
      searchQuery,
      searchKinds.join(','),
      searchScope,
      topK,
    ].join('\u0000');
    return (
      <div className="mx-auto max-w-3xl space-y-4">
        {header}
        <Suspense
          key={searchKey}
          fallback={
            <div className="space-y-3" data-testid="search-loading">
              {[0, 1, 2].map((row) => (
                <Skeleton key={row} className="h-28 w-full rounded-xl" />
              ))}
            </div>
          }
        >
          <RankedResults
            query={searchQuery}
            kinds={searchKinds}
            scope={searchScope}
            k={topK}
          />
        </Suspense>
      </div>
    );
  }

  let query = supabase
    .from('memories')
    // `count: exact` returns the total alongside this page, for the pager.
    .select(MEMORY_COLUMNS, { count: 'exact' })
    .order('created_at', { ascending: false })
    .range(offset, offset + PAGE_SIZE - 1);
  if (kind) {
    query = query.eq('kind', kind);
  }
  if (visibility) {
    query = query.eq('visibility', visibility);
  }
  if (scope) {
    query = query.eq('scope', scope);
  }
  // Lifecycle status — the SQL twin of matchesFeedStatus. `all` adds nothing.
  if (status === 'active') {
    // Everything except a historical version (retired AND replaced).
    query = query.or('invalidated_at.is.null,superseded_by.is.null');
  } else if (status === 'live') {
    query = query.is('invalidated_at', null);
  } else if (status === 'superseded') {
    query = query
      .not('invalidated_at', 'is', null)
      .not('superseded_by', 'is', null);
  } else if (status === 'invalidated') {
    query = query.not('invalidated_at', 'is', null).is('superseded_by', null);
  }
  if (q) {
    if (idPrefix) {
      // An id (or id fragment) pasted from a card: prefix-match the id. The
      // `_` in `mem_` is a LIKE single-char wildcard — escape it.
      query = query.like('id', `${idPrefix.replaceAll('_', '\\_')}%`);
    } else {
      query = query.ilike('content', `%${q}%`);
    }
  }

  const { data, count, error } = await query;
  const memories = (data ?? []) as unknown as MemoryRow[];
  const totalPages = Math.max(1, Math.ceil((count ?? 0) / PAGE_SIZE));

  // "Has history" flag per card: a memory is part of a supersession chain when
  // it is itself superseded (older version) or something on this page points at
  // it (it replaced an older version). One RLS-scoped probe for the page's ids.
  const pageIds = memories.map((memory) => memory.id);
  const supersededTargets = new Set<string>();
  if (pageIds.length > 0) {
    const { data: predecessorRows } = await supabase
      .from('memories')
      .select('superseded_by')
      .in('superseded_by', pageIds);
    for (const row of predecessorRows ?? []) {
      if (typeof row.superseded_by === 'string') {
        supersededTargets.add(row.superseded_by);
      }
    }
  }
  const hasHistory = (memory: MemoryRow): boolean =>
    Boolean(memory.superseded_by) || supersededTargets.has(memory.id);

  // Sharing-badge honesty: a `shared`-visibility memory reads "shared" only
  // when its scope truly has members beyond the owner, else "sharable". One
  // RLS-scoped grouped query over the shared scopes on this page.
  const memberCounts = await loadScopeMemberCounts(
    supabase,
    memories
      .filter((memory) => memory.visibility === 'shared')
      .map((memory) => String(memory.scope))
  );
  const memberCountOf = (memory: MemoryRow): number | undefined =>
    memory.visibility === 'shared'
      ? (memberCounts.get(String(memory.scope)) ?? 0)
      : undefined;

  // The feed's current filters, carried into each card link as `from` so the
  // detail page's "back to feed" restores this filtered view instead of a reset.
  const backTo = filterQuery(
    { kind, visibility, q, scope, status },
    page
  ).toString();

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      {header}

      {error ? (
        <Alert variant="destructive">
          <AlertDescription>
            {t('feed.loadError', { message: error.message })}
          </AlertDescription>
        </Alert>
      ) : null}

      <RealtimeFeed
        messages={messages}
        memberCounts={Object.fromEntries(memberCounts)}
        backTo={backTo}
        status={status}
      />

      <div className="space-y-3" data-testid="memory-feed">
        {memories.map((memory) => (
          <MemoryCard
            key={memory.id}
            data-testid="memory-card"
            linkComponent={Link}
            {...memoryCardProps(
              memory,
              t,
              hasHistory(memory),
              memberCountOf(memory),
              backTo
            )}
          />
        ))}
        {!error && memories.length === 0 ? (
          <EmptyState className="rounded-xl border border-dashed">
            {t('feed.empty')}
          </EmptyState>
        ) : null}
      </div>

      <FeedPagination
        linkComponent={Link}
        newerHref={
          page > 1
            ? pageHref({ kind, visibility, q, scope, status }, page - 1)
            : undefined
        }
        olderHref={
          page < totalPages
            ? pageHref({ kind, visibility, q, scope, status }, page + 1)
            : undefined
        }
        pageLabel={t('feed.page', { page, total: totalPages })}
        newerLabel={t('feed.newer')}
        olderLabel={t('feed.older')}
      />
    </div>
  );
}
