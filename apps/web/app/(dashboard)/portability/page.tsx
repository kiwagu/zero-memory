import { Badge } from '@workspace/ui/components/badge';
import type {
  PortabilityCandidateItem,
  PortabilityCandidateQueueLabels,
} from '@workspace/ui/components/portability/portability-candidate-queue';

import { PortabilityCandidateList } from '@/components/portability-candidate.client';
import { ReviewScanButton } from '@/components/review-scan';
import { getRequestMessages } from '@/lib/i18n';
import { createServerSupabaseClient } from '@/lib/supabase/server';

/** Recently approved re-scopes stay visible as the outcome shelf. */
const MAX_APPROVED_ROWS = 10;
/** Memory preview length on the card. */
const PREVIEW_CHARS = 400;

const CANDIDATE_COLUMNS =
  'id, memory_id, from_scope, to_scope, judge_confidence, judge_rationale, status' as const;

type CandidateRow = {
  id: string;
  memory_id: string;
  from_scope: unknown;
  to_scope: unknown;
  judge_confidence: number | null;
  judge_rationale: string | null;
  status: string;
};

export default async function PortabilityPage() {
  const supabase = await createServerSupabaseClient();
  const { t } = await getRequestMessages();

  // Pending proposals the owner may resolve (RLS scopes rows to the owner).
  // Verdict-less rows (judgement still in flight) stay invisible.
  const { data: pendingRows, count: pendingCount } = await supabase
    .from('portability_candidates')
    .select(CANDIDATE_COLUMNS, { count: 'exact' })
    .eq('status', 'pending')
    .not('judge_confidence', 'is', null)
    .order('created_at', { ascending: true });

  // Recent approvals: the re-scopes the audit actually produced.
  const { data: approvedRows, count: approvedCount } = await supabase
    .from('portability_candidates')
    .select(CANDIDATE_COLUMNS, { count: 'exact' })
    .eq('status', 'approved')
    .order('resolved_at', { ascending: false })
    .limit(MAX_APPROVED_ROWS);

  const rows = [
    ...((pendingRows ?? []) as CandidateRow[]),
    ...((approvedRows ?? []) as CandidateRow[]),
  ];

  // The proposed memories' content, one batch, keyed client-side.
  const memoryIds = [...new Set(rows.map((row) => row.memory_id))];
  const { data: memories } = memoryIds.length
    ? await supabase
        .from('memories')
        .select('id, kind, content')
        .in('id', memoryIds)
    : { data: [] };
  const memoryById = new Map((memories ?? []).map((m) => [m.id, m]));

  const toItem = (row: CandidateRow): PortabilityCandidateItem[] => {
    const memory = memoryById.get(row.memory_id);
    if (!memory) {
      return [];
    }
    const content = String(memory.content);
    return [
      {
        id: row.id,
        status: row.status as PortabilityCandidateItem['status'],
        memoryHref: `/memory/${row.memory_id}`,
        kind: String(memory.kind),
        content:
          content.length > PREVIEW_CHARS
            ? `${content.slice(0, PREVIEW_CHARS)}…`
            : content,
        // ltree columns are generated as `unknown`; strings on the wire.
        fromScope: row.from_scope as string,
        toScope: row.to_scope as string,
        confidence: row.judge_confidence,
        rationale: row.judge_rationale,
      },
    ];
  };

  const pendingItems = ((pendingRows ?? []) as CandidateRow[]).flatMap(toItem);
  const approvedItems = ((approvedRows ?? []) as CandidateRow[]).flatMap(
    toItem
  );

  const labels: PortabilityCandidateQueueLabels = {
    empty: t('portability.empty'),
    confidence: t('portability.confidence'),
    approvedBadge: t('portability.approvedBadge'),
    actions: {
      approve: t('portability.actions.approve'),
      dismiss: t('portability.actions.dismiss'),
    },
  };

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-semibold">{t('portability.title')}</h1>
            <Badge
              variant={(pendingCount ?? 0) > 0 ? 'amber' : 'secondary'}
              data-testid="portability-pending-count"
            >
              {t('portability.pendingCount', { count: pendingCount ?? 0 })}
            </Badge>
            {/* The outcome metric: world facts promoted into core. */}
            <Badge variant="secondary" data-testid="portability-approved-count">
              {t('portability.approvedCount', { count: approvedCount ?? 0 })}
            </Badge>
          </div>
          <p className="text-muted-foreground text-sm">
            {t('portability.description')}
          </p>
        </div>
        {/* The hygiene scan also runs portability detection (one pipeline). */}
        <ReviewScanButton
          labels={{
            scan: t('portability.scan.button'),
            scanning: t('review.scan.pending'),
            started: t('portability.scan.started'),
            modeQuick: t('review.scan.modeQuick'),
            modeFull: t('review.scan.modeFull'),
          }}
        />
      </div>

      <PortabilityCandidateList items={pendingItems} labels={labels} />

      {approvedItems.length > 0 ? (
        <div className="space-y-4">
          <h2 className="text-lg font-medium">
            {t('portability.approvedTitle')}
          </h2>
          <PortabilityCandidateList items={approvedItems} labels={labels} />
        </div>
      ) : null}
    </div>
  );
}
