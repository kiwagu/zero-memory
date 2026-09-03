import { Badge } from '@workspace/ui/components/badge';
import type {
  ReflectionCandidateItem,
  ReflectionCandidateQueueLabels,
  ReflectionMemberItem,
} from '@workspace/ui/components/reflections/reflection-candidate-queue';

import { ReflectionCandidateList } from '@/components/reflection-candidate.client';
import { ReviewScanButton } from '@/components/review-scan';
import { getRequestMessages } from '@/lib/i18n';
import { formatTimestamp } from '@/lib/memory';
import { createServerSupabaseClient } from '@/lib/supabase/server';

/** Recently approved consolidations stay visible as the outcome shelf. */
const MAX_APPROVED_ROWS = 10;
/** Member preview length on the card. */
const PREVIEW_CHARS = 140;

const CANDIDATE_COLUMNS =
  'id, scope, distilled_content, distilled_kind, judge_confidence, judge_rationale, status, approved_memory_id' as const;

type CandidateRow = {
  id: string;
  scope: unknown;
  distilled_content: string | null;
  distilled_kind: string | null;
  judge_confidence: number | null;
  judge_rationale: string | null;
  status: string;
  approved_memory_id: string | null;
};

type MemberRow = {
  candidate_id: string;
  memory_id: string;
  ord: number;
};

export default async function ReflectionsPage() {
  const supabase = await createServerSupabaseClient();
  const { t } = await getRequestMessages();

  // Pending drafts the owner may resolve (RLS scopes rows to the owner).
  // Draft-less rows (distillation still in flight) stay invisible.
  const { data: pendingRows, count: pendingCount } = await supabase
    .from('reflection_candidates')
    .select(CANDIDATE_COLUMNS, { count: 'exact' })
    .eq('status', 'pending')
    .not('distilled_content', 'is', null)
    .order('created_at', { ascending: true });

  // Recent approvals: the consolidated memories reflection actually produced.
  const { data: approvedRows, count: approvedCount } = await supabase
    .from('reflection_candidates')
    .select(CANDIDATE_COLUMNS, { count: 'exact' })
    .eq('status', 'approved')
    .order('resolved_at', { ascending: false })
    .limit(MAX_APPROVED_ROWS);

  const rows = [
    ...((pendingRows ?? []) as CandidateRow[]),
    ...((approvedRows ?? []) as CandidateRow[]),
  ];

  // Members of every visible candidate, chronological, plus their episode
  // previews — one query each, keyed client-side.
  const candidateIds = rows.map((row) => row.id);
  const { data: memberRows } = candidateIds.length
    ? await supabase
        .from('reflection_candidate_members')
        .select('candidate_id, memory_id, ord')
        .in('candidate_id', candidateIds)
        .order('ord', { ascending: true })
    : { data: [] };
  const members = (memberRows ?? []) as MemberRow[];

  const memoryIds = [...new Set(members.map((member) => member.memory_id))];
  const { data: memories } = memoryIds.length
    ? await supabase
        .from('memories')
        .select('id, content, created_at')
        .in('id', memoryIds)
    : { data: [] };
  const memoryById = new Map((memories ?? []).map((m) => [m.id, m]));

  const membersOf = (candidateId: string): ReflectionMemberItem[] =>
    members
      .filter((member) => member.candidate_id === candidateId)
      .flatMap((member) => {
        const memory = memoryById.get(member.memory_id);
        if (!memory) {
          return [];
        }
        return [
          {
            id: memory.id,
            href: `/memory/${memory.id}`,
            when: formatTimestamp(memory.created_at),
            preview:
              String(memory.content).length > PREVIEW_CHARS
                ? `${String(memory.content).slice(0, PREVIEW_CHARS)}…`
                : String(memory.content),
          },
        ];
      });

  const toItem = (row: CandidateRow): ReflectionCandidateItem[] => {
    if (!row.distilled_content || !row.distilled_kind) {
      return [];
    }
    return [
      {
        id: row.id,
        status: row.status as ReflectionCandidateItem['status'],
        content: row.distilled_content,
        kind: row.distilled_kind,
        // reflection_candidates.scope is ltree, generated as `unknown`; it is
        // a string on the wire.
        scope: row.scope as string,
        confidence: row.judge_confidence,
        rationale: row.judge_rationale,
        members: membersOf(row.id),
        approvedMemoryHref: row.approved_memory_id
          ? `/memory/${row.approved_memory_id}`
          : undefined,
      },
    ];
  };

  const pendingItems = ((pendingRows ?? []) as CandidateRow[]).flatMap(toItem);
  const approvedItems = ((approvedRows ?? []) as CandidateRow[]).flatMap(
    toItem
  );

  const labels: ReflectionCandidateQueueLabels = {
    empty: t('reflections.empty'),
    confidence: t('reflections.confidence'),
    sources: t('reflections.sources'),
    approvedBadge: t('reflections.approvedBadge'),
    approvedMemory: t('reflections.approvedMemory'),
    actions: {
      approve: t('reflections.actions.approve'),
      dismiss: t('reflections.actions.dismiss'),
      snooze: t('reflections.actions.snooze'),
    },
  };

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-semibold">{t('reflections.title')}</h1>
            <Badge
              variant={(pendingCount ?? 0) > 0 ? 'amber' : 'secondary'}
              data-testid="reflections-pending-count"
            >
              {t('reflections.pendingCount', { count: pendingCount ?? 0 })}
            </Badge>
            {/* The outcome metric: living facts born from episode noise. */}
            <Badge variant="secondary" data-testid="reflections-approved-count">
              {t('reflections.approvedCount', { count: approvedCount ?? 0 })}
            </Badge>
          </div>
          <p className="text-muted-foreground text-sm">
            {t('reflections.description')}
          </p>
        </div>
        {/* The hygiene scan also runs reflection detection (one pipeline). */}
        <ReviewScanButton
          labels={{
            scan: t('reflections.scan.button'),
            scanning: t('review.scan.pending'),
            started: t('reflections.scan.started'),
            modeQuick: t('review.scan.modeQuick'),
            modeFull: t('review.scan.modeFull'),
          }}
        />
      </div>

      <ReflectionCandidateList items={pendingItems} labels={labels} />

      {approvedItems.length > 0 ? (
        <div className="space-y-4">
          <h2 className="text-lg font-medium">
            {t('reflections.approvedTitle')}
          </h2>
          <ReflectionCandidateList items={approvedItems} labels={labels} />
        </div>
      ) : null}
    </div>
  );
}
