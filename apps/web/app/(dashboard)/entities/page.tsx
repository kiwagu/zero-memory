import Link from 'next/link';

import { Alert, AlertDescription } from '@workspace/ui/components/alert';
import { EmptyState } from '@workspace/ui/components/common/empty-state';
import { EntityCard } from '@workspace/ui/components/entity/entity-card';
import { FeedPagination } from '@workspace/ui/components/memory/feed-pagination';

import { EntityDetails } from '@/components/entity-details';
import { EntitySearch } from '@/components/entity-search';
import { getRequestMessages } from '@/lib/i18n';
import { PAGE_SIZE, formatTimestamp, scopeLabel } from '@/lib/memory';
import { createServerSupabaseClient } from '@/lib/supabase/server';

function pageHref(search: string, page: number): string {
  const query = new URLSearchParams();
  if (search) query.set('q', search);
  if (page > 1) query.set('page', String(page));
  const encoded = query.toString();
  return encoded ? `/entities?${encoded}` : '/entities';
}

export default async function EntitiesPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; page?: string }>;
}) {
  const { q, page: pageParam } = await searchParams;
  const search = q?.trim() ?? '';
  const page = Math.max(1, Number.parseInt(pageParam ?? '1', 10) || 1);
  const offset = (page - 1) * PAGE_SIZE;
  const { t } = await getRequestMessages();

  const supabase = await createServerSupabaseClient();
  let query = supabase
    .from('entities')
    // `count: exact` returns the total alongside this page, for the pager.
    .select('id, name, type, scope, created_at', { count: 'exact' })
    .order('created_at', { ascending: false })
    .range(offset, offset + PAGE_SIZE - 1);
  if (search) {
    query = query.ilike('name', `%${search}%`);
  }
  const { data, count, error } = await query;
  const entities = data ?? [];
  const totalPages = Math.max(1, Math.ceil((count ?? 0) / PAGE_SIZE));

  const connectionLabels = {
    summary: t('entities.connections.summary'),
    loading: t('entities.connections.loading'),
    edgesTitle: t('entities.connections.edgesTitle'),
    noEdges: t('entities.connections.noEdges'),
    memoriesTitle: t('entities.connections.memoriesTitle'),
    noMemories: t('entities.connections.noMemories'),
    invalidated: t('memory.invalidated'),
  };

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold">{t('entities.title')}</h1>
        <EntitySearch
          placeholder={t('entities.searchPlaceholder')}
          submitLabel={t('entities.search')}
        />
      </div>

      {error ? (
        <Alert variant="destructive">
          <AlertDescription>
            {t('entities.loadError', { message: error.message })}
          </AlertDescription>
        </Alert>
      ) : null}

      <div className="space-y-2">
        {entities.map((entity) => (
          <EntityCard
            key={entity.id}
            name={entity.name}
            timestamp={formatTimestamp(entity.created_at)}
            badges={[
              { label: entity.type, variant: 'blue' },
              { label: scopeLabel(entity.scope), variant: 'amber' },
            ]}
          >
            <EntityDetails entityId={entity.id} labels={connectionLabels} />
          </EntityCard>
        ))}
        {!error && entities.length === 0 ? (
          <EmptyState className="rounded-xl border border-dashed">
            {search
              ? t('entities.emptySearch', { search })
              : t('entities.empty')}
          </EmptyState>
        ) : null}
      </div>

      {totalPages > 1 ? (
        <FeedPagination
          linkComponent={Link}
          newerHref={page > 1 ? pageHref(search, page - 1) : undefined}
          olderHref={page < totalPages ? pageHref(search, page + 1) : undefined}
          pageLabel={t('entities.pager.page', { page, total: totalPages })}
          newerLabel={t('entities.pager.prev')}
          olderLabel={t('entities.pager.next')}
        />
      ) : null}
    </div>
  );
}
