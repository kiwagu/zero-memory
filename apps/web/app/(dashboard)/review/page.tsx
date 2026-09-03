import Link from 'next/link';

import { Badge } from '@workspace/ui/components/badge';
import { FeedPagination } from '@workspace/ui/components/memory/feed-pagination';
import type {
  ReviewItem,
  ReviewQueueLabels,
  ReviewVerdict,
} from '@workspace/ui/components/review/review-queue';

import { ReviewList } from '@/components/review-list';
import { ReviewScanButton } from '@/components/review-scan';
import { getRequestMessages } from '@/lib/i18n';
import { PAGE_SIZE, formatTimestamp } from '@/lib/memory';
import { createServerSupabaseClient } from '@/lib/supabase/server';

export default async function ReviewPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string }>;
}) {
  const supabase = await createServerSupabaseClient();
  const { t } = await getRequestMessages();

  const page = Math.max(
    1,
    Number.parseInt((await searchParams).page ?? '1', 10) || 1
  );
  const offset = (page - 1) * PAGE_SIZE;

  // Pending conflicts the owner may resolve (RLS scopes rows to owned pairs).
  // `count: exact` returns the total alongside this page, for the pager.
  // This surface reviews PAIRS; single-subject disputes (challenged /
  // stale_suspect, memory_b null) are triaged through the agent tools, so
  // they are excluded here rather than counted-but-unrenderable.
  const { data: pageRows, count } = await supabase
    .from('memory_review_queue')
    .select('id, verdict, confidence, rationale, memory_a, memory_b', {
      count: 'exact',
    })
    .eq('status', 'pending')
    .not('memory_b', 'is', null)
    .order('created_at', { ascending: true })
    .range(offset, offset + PAGE_SIZE - 1);

  const totalPages = Math.max(1, Math.ceil((count ?? 0) / PAGE_SIZE));
  const rows = pageRows ?? [];

  const ids = [...new Set(rows.flatMap((row) => [row.memory_a, row.memory_b]))];
  const { data: memories } = ids.length
    ? await supabase
        .from('memories')
        .select('id, kind, content, created_at')
        .in('id', ids)
    : { data: [] };
  const byId = new Map((memories ?? []).map((memory) => [memory.id, memory]));

  const items: ReviewItem[] = rows.flatMap((row) => {
    const first = byId.get(row.memory_a);
    const second = byId.get(row.memory_b);
    if (!first || !second) {
      return [];
    }
    // Display the older memory on the left (A) and the newer on the right (B).
    const [older, newer] =
      (first.created_at ?? '') <= (second.created_at ?? '')
        ? [first, second]
        : [second, first];
    return [
      {
        id: row.id,
        verdict: row.verdict as ReviewVerdict,
        confidence: row.confidence,
        rationale: row.rationale,
        memoryA: {
          id: older.id,
          kind: older.kind,
          created: formatTimestamp(older.created_at),
          content: older.content,
          href: `/memory/${older.id}`,
        },
        memoryB: {
          id: newer.id,
          kind: newer.kind,
          created: formatTimestamp(newer.created_at),
          content: newer.content,
          href: `/memory/${newer.id}`,
        },
      },
    ];
  });

  const labels: ReviewQueueLabels = {
    empty: t('review.empty'),
    confidence: t('review.confidence'),
    merge: t('review.actions.merge'),
    verdict: {
      duplicate: t('review.verdict.duplicate'),
      supersedes: t('review.verdict.supersedes'),
      contradiction: t('review.verdict.contradiction'),
      unjudged: t('review.verdict.unjudged'),
    },
    actions: {
      keep_both: t('review.actions.keepBoth'),
      forget_a: t('review.actions.forgetA'),
      forget_b: t('review.actions.forgetB'),
      supersede_a_b: t('review.actions.supersedeAB'),
      supersede_b_a: t('review.actions.supersedeBA'),
    },
  };

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-semibold">{t('review.title')}</h1>
            {/* Total pending conflicts (not just this page) — amber demands
                attention, secondary reads as "queue is clean". */}
            <Badge
              variant={(count ?? 0) > 0 ? 'amber' : 'secondary'}
              data-testid="review-pending-count"
            >
              {t('review.pendingCount', { count: count ?? 0 })}
            </Badge>
          </div>
          <p className="text-muted-foreground text-sm">
            {t('review.description')}
          </p>
        </div>
        <ReviewScanButton
          labels={{
            scan: t('review.scan.button'),
            scanning: t('review.scan.pending'),
            started: t('review.scan.started'),
            modeQuick: t('review.scan.modeQuick'),
            modeFull: t('review.scan.modeFull'),
          }}
        />
      </div>
      <ReviewList
        items={items}
        labels={labels}
        mergeLabels={{
          title: t('review.merge.title'),
          submit: t('review.merge.submit'),
          submitPending: t('review.merge.submitPending'),
          cancel: t('review.merge.cancel'),
        }}
      />

      {totalPages > 1 ? (
        <FeedPagination
          linkComponent={Link}
          newerHref={page > 1 ? pageHref(page - 1) : undefined}
          olderHref={page < totalPages ? pageHref(page + 1) : undefined}
          pageLabel={t('review.pager.page', { page, total: totalPages })}
          newerLabel={t('review.pager.prev')}
          olderLabel={t('review.pager.next')}
        />
      ) : null}
    </div>
  );
}

const pageHref = (page: number): string =>
  page > 1 ? `/review?page=${page}` : '/review';
