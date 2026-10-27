import Link from 'next/link';
import { notFound } from 'next/navigation';

import { MemoryDetailView } from '@/components/memory-detail-view';
import { getRequestMessages } from '@/lib/i18n';
import { loadMemoryView } from '@/lib/views/memory.view';

export default async function MemoryDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ from?: string }>;
}) {
  const { id } = await params;
  // `from` carries the feed's filter query (set by the card link) so the back
  // link returns to that filtered view. It is only ever used as the query part
  // of the same-origin /memories path, so it cannot redirect elsewhere.
  const { from } = await searchParams;
  const backToFeedHref = from ? `/memories?${from}` : '/memories';

  const view = await loadMemoryView(id);
  if (!view) {
    notFound();
  }
  const { t } = await getRequestMessages();

  return (
    <div className="mx-auto max-w-3xl">
      <MemoryDetailView
        view={view}
        header={
          <Link
            href={backToFeedHref}
            className="text-sm text-muted-foreground hover:underline"
          >
            {t('memory.backToFeed')}
          </Link>
        }
      />
    </div>
  );
}
