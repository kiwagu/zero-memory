import Link from 'next/link';

import {
  type DeliveryCandidate,
  deliveredRuleIdsNow,
  ruleDeliveryCutoffNow,
} from '@workspace/db';
import { Badge } from '@workspace/ui/components/badge';
import type {
  RuleCandidateItem,
  RuleCandidateQueueLabels,
  RuleScopeSuggestion,
  RuleTargetLayerKind,
} from '@workspace/ui/components/rules/rule-candidate-queue';
import {
  isPersonalScope,
  scopeOptionLabel,
} from '@workspace/ui/lib/scope-format';

import { RuleCandidateList } from '@/components/rule-candidate.client';
import { RulesFilter } from '@/components/rules-filter';
import { ReviewScanButton } from '@/components/review-scan';
import { getRequestMessages } from '@/lib/i18n';
import { formatTimestamp } from '@/lib/memory';
import { createServerSupabaseClient } from '@/lib/supabase/server';

/** Scope-filter sentinel selecting the General (user-layer) rules. */
const GENERAL_FILTER = '__general__';

const CANDIDATE_COLUMNS =
  'id, memory_id, useful_sessions, first_used_at, last_used_at, rule_text, target_layer, judge_confidence, judge_rationale, status, suggested_scopes, applies_scope, pinned, carried_from, text_review_since' as const;

/** The pinned facet: pinned only, or unpinned only. */
const PINNED_VALUES = ['pinned', 'unpinned'] as const;
/** The delivery facet: what a session receives, or promoted but dropped. */
const DELIVERY_VALUES = ['delivered', 'undelivered'] as const;

/**
 * Rule candidates are a curated, low-volume incubator output (not the raw
 * memory stream), so the review surface fetches them all up to this cap and
 * groups by project in memory — pagination would split a project across pages.
 */
const GROUP_FETCH_CAP = 300;

type CandidateRow = {
  id: string;
  memory_id: string;
  useful_sessions: number;
  first_used_at: string | null;
  last_used_at: string | null;
  rule_text: string | null;
  target_layer: string | null;
  judge_confidence: number | null;
  judge_rationale: string | null;
  status: string;
  suggested_scopes: unknown;
  applies_scope: unknown;
  pinned: boolean;
  carried_from: string | null;
  text_review_since: string | null;
};

/**
 * Parse the stored ranked recommendation, tolerating rows written before the
 * column existed (or a malformed payload): the deterministic fallback is the
 * origin scope alone.
 */
const parseSuggestedScopes = (
  raw: unknown,
  originScope: string
): RuleScopeSuggestion[] => {
  const fallback: RuleScopeSuggestion[] = [
    { scope: originScope, score: 1, source: 'origin' },
  ];
  if (!Array.isArray(raw)) {
    return fallback;
  }
  const parsed = raw.flatMap((entry): RuleScopeSuggestion[] => {
    if (typeof entry !== 'object' || entry === null) {
      return [];
    }
    const { scope, score, source } = entry as Record<string, unknown>;
    if (typeof scope !== 'string' || typeof score !== 'number') {
      return [];
    }
    if (source !== 'origin' && source !== 'global' && source !== 'llm') {
      return [];
    }
    return [{ scope, score, source }];
  });
  return parsed.length > 0 ? parsed : fallback;
};

export default async function RulesPage({
  searchParams,
}: {
  searchParams: Promise<{
    scope?: string;
    status?: string;
    pinned?: string;
    delivery?: string;
  }>;
}) {
  const supabase = await createServerSupabaseClient();
  const { t } = await getRequestMessages();
  const params = await searchParams;
  const selectedScope = params.scope;
  const selectedStatus = ['pending', 'promoted', 'dismissed', 'all'].includes(
    params.status ?? ''
  )
    ? (params.status as 'pending' | 'promoted' | 'dismissed' | 'all')
    : 'pending';
  // The concrete statuses "all" spans (revoked stays out of the review view).
  const ALL_STATUSES = ['pending', 'promoted', 'dismissed'] as const;
  // Facets whose default is "any": absent from the URL unless chosen.
  const selectedPinned =
    PINNED_VALUES.find((value) => value === params.pinned) ?? null;
  const selectedDelivery =
    DELIVERY_VALUES.find((value) => value === params.delivery) ?? null;

  // The scope filter has three modes: none, the "General" sentinel (the
  // user-layer group — no project home), or a concrete project scope.
  const generalSelected =
    selectedScope === GENERAL_FILTER ||
    (selectedScope !== undefined && isPersonalScope(selectedScope));

  // Project-scope filter: a rule matches when the selected scope is anywhere
  // in its ranked recommendation (origin or speculative). jsonb containment
  // (@>) keeps the filter in the DB.
  //
  // Pass a JSON STRING, not a JS array: postgrest-js `.contains()` routes an
  // Array value through its Postgres-ARRAY branch (`cs.{a,b}`) and does
  // `value.join(',')`, which stringifies `[{scope}]` to "[object Object]" and
  // matches nothing. A string hits the raw branch and emits the jsonb literal
  // verbatim (`cs.[{"scope":"X"}]`), the valid `@>` containment we want.
  const scopeFilter =
    selectedScope && !generalSelected
      ? JSON.stringify([{ scope: selectedScope }])
      : null;

  // One list, driven by the STATUS filter (default pending). Draft-less
  // pending rows (distillation still in flight) stay invisible.
  //
  // Order mirrors DELIVERY: pinned rules first — they are the ones guaranteed
  // to reach a session — then newest first WITHIN each group, by created_at.
  // created_at is IMMUTABLE, so a row never jumps when you act on it
  // (promote/revoke/dismiss change promoted_at/resolved_at, which used to
  // reorder the whole list under your cursor); pinning is the one deliberate
  // exception, and it moves the row to the top where the pin says it belongs.
  let listQuery = supabase
    .from('rule_candidates')
    .select(CANDIDATE_COLUMNS)
    .not('rule_text', 'is', null);
  listQuery =
    selectedStatus === 'all'
      ? listQuery.in('status', [...ALL_STATUSES])
      : listQuery.eq('status', selectedStatus);
  if (generalSelected) {
    // General = the user-layer group (personal home, no project). target_layer
    // 'user' is exactly that set (a project-addressed rule is 'project').
    listQuery = listQuery.eq('target_layer', 'user');
  } else if (scopeFilter) {
    listQuery = listQuery.contains('suggested_scopes', scopeFilter);
  }
  if (selectedPinned) {
    listQuery = listQuery.eq('pinned', selectedPinned === 'pinned');
  }
  const { data: listRows } = await listQuery
    .order('pinned', { ascending: false })
    .order('created_at', { ascending: false })
    .limit(GROUP_FETCH_CAP);

  // Header badges keep the standing totals (filter-agnostic). Every number
  // about delivery comes from ONE read of the live promoted rules and one
  // function — the readers' own rule (pinned always, then per channel the
  // newest unpinned within the TTL, up to the cap) — so the badges, the
  // delivery facet and what a session actually receives cannot disagree.
  // The same set drives the facet below.
  const deliveryCutoff = ruleDeliveryCutoffNow();
  const [{ count: pendingCount }, { data: liveRows }] = await Promise.all([
    supabase
      .from('rule_candidates')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'pending')
      .not('rule_text', 'is', null),
    supabase
      .from('rule_candidates')
      .select(
        'id, target_layer, applies_scope, pinned, promoted_at, memories!inner(scope)'
      )
      .eq('status', 'promoted')
      .not('rule_text', 'is', null),
  ]);
  const live: DeliveryCandidate[] = (liveRows ?? []).map((row) => ({
    id: row.id,
    targetLayer: row.target_layer === 'user' ? 'user' : 'project',
    effectiveScope: String(
      row.applies_scope ??
        (row.memories as unknown as { scope: unknown }).scope ??
        ''
    ),
    pinned: row.pinned,
    promotedAt: row.promoted_at,
  }));
  const deliveredIds = deliveredRuleIdsNow(live);
  const promotedCount = live.length;
  const pinnedCount = live.filter((rule) => rule.pinned).length;
  // "Delivered N of M" speaks for the General channel, which rides every
  // session: M = every live General rule, N = the ones a session receives.
  const generalLive = live.filter((rule) => rule.targetLayer === 'user');
  const deliveryTotal = generalLive.length;
  const deliveredCount = generalLive.filter((rule) =>
    deliveredIds.has(rule.id)
  ).length;
  const deliveryTruncated = deliveryTotal > deliveredCount;

  // Distinct project scopes across the owner's candidates drive the filter's
  // per-project options — computed server-side via the RPC so it scales with
  // the queue. Personal scopes are dropped here; they collapse into a single
  // "General" option instead.
  const { data: scopeRows } = await supabase.rpc('rule_candidate_scopes');
  const availableScopes = (scopeRows ?? [])
    .map((row) => row.scope)
    .filter((scope) => !isPersonalScope(scope));

  // "General" is offered whenever ANY user-layer candidate exists — counted
  // directly, not inferred from suggested_scopes (a promoted user rule may
  // carry none). Covers every reviewable status so the option is stable
  // across the status filter.
  const { count: generalCount } = await supabase
    .from('rule_candidates')
    .select('id', { count: 'exact', head: true })
    .eq('target_layer', 'user')
    .not('rule_text', 'is', null)
    .in('status', [...ALL_STATUSES]);
  const hasGeneral = (generalCount ?? 0) > 0;

  // The delivery facet reads the same set as the badges: "not delivered" is
  // a promoted rule a session does not receive (over the cap, past the TTL).
  const rows = ((listRows ?? []) as CandidateRow[]).filter((row) => {
    if (selectedDelivery === 'delivered') {
      return deliveredIds.has(row.id);
    }
    if (selectedDelivery === 'undelivered') {
      return row.status === 'promoted' && !deliveredIds.has(row.id);
    }
    return true;
  });
  const memoryIds = [...new Set(rows.map((row) => row.memory_id))];
  const { data: memories } = memoryIds.length
    ? await supabase
        .from('memories')
        .select('id, kind, scope, invalidated_at, superseded_by')
        .in('id', memoryIds)
    : { data: [] };
  const memoryById = new Map(
    (memories ?? []).map((memory) => [memory.id, memory])
  );
  // Usefulness signal: a promoted rule whose SOURCE memory was reinforced
  // (recall-used) but has since gone cold is a "still relevant?" review hint.
  // Rules that were never reinforced (e.g. on-demand promotions) carry no such
  // claim, so they are not flagged.
  const { data: reinforcements } = memoryIds.length
    ? await supabase
        .from('memory_reinforcement')
        .select('memory_id, last_used_at')
        .in('memory_id', memoryIds)
    : { data: [] };
  const reinforcedAtByMemory = new Map(
    (reinforcements ?? []).flatMap((r) =>
      r.last_used_at ? [[r.memory_id, String(r.last_used_at)] as const] : []
    )
  );

  // A rule's project HOME = its explicit delivery address (applies_scope) or,
  // failing that, its anchor memory's scope. Personal-scope homes collapse
  // into one "General" group (user-layer rules — no project). Rows stay in
  // their created_at order within a group.
  const built = rows.flatMap((row) => {
    const memory = memoryById.get(row.memory_id);
    if (!memory || !row.rule_text) {
      return [];
    }
    const memoryScope = memory.scope as string;
    const effective = row.applies_scope
      ? String(row.applies_scope)
      : memoryScope;
    // Cold = the source memory WAS reinforced but its last useful recall has
    // aged past the delivery window. Only meaningful for a promoted rule.
    const reinforcedAt = reinforcedAtByMemory.get(row.memory_id);
    const cold =
      row.status === 'promoted' &&
      reinforcedAt !== undefined &&
      reinforcedAt < deliveryCutoff;
    const item: RuleCandidateItem = {
      id: row.id,
      status: row.status as RuleCandidateItem['status'],
      ruleText: row.rule_text,
      targetLayer: (row.target_layer ?? 'project') as RuleTargetLayerKind,
      confidence: row.judge_confidence,
      rationale: row.judge_rationale,
      usefulSessions: row.useful_sessions,
      firstUsed: row.first_used_at ? formatTimestamp(row.first_used_at) : null,
      lastUsed: row.last_used_at ? formatTimestamp(row.last_used_at) : null,
      memory: {
        id: memory.id,
        kind: memory.kind,
        // memories.scope is ltree, generated as `unknown`; a string on the wire.
        scope: memoryScope,
        href: `/memory/${memory.id}`,
      },
      scopes: parseSuggestedScopes(row.suggested_scopes, memoryScope),
      staleSignal: cold ? t('rules.staleSignal') : null,
      pinned: row.pinned,
      // A promoted rule follows the successor of its memory; these say when
      // that left something for the owner: a curated text kept through the
      // move, or a rule still anchored to a memory that was retired.
      reviewSignal:
        row.status === 'promoted' && row.text_review_since
          ? t('rules.reviewSignal')
          : null,
      sourceSignal:
        row.status !== 'promoted' || !memory.invalidated_at
          ? null
          : memory.superseded_by
            ? t('rules.sourceSuperseded')
            : t('rules.sourceForgotten'),
      carriedFrom: row.carried_from
        ? { id: row.carried_from, href: `/memory/${row.carried_from}` }
        : null,
    };
    return [
      { groupScope: isPersonalScope(effective) ? null : effective, item },
    ];
  });
  const listItems = built.map((entry) => entry.item);

  // Aliases for the filter dropdown AND the group headings (their union).
  const projectGroupScopes = built
    .map((entry) => entry.groupScope)
    .filter((scope): scope is string => scope !== null);
  const aliasLookupScopes = [
    ...new Set([...availableScopes, ...projectGroupScopes]),
  ];
  const { data: aliasRows } = aliasLookupScopes.length
    ? await supabase
        .from('scopes')
        .select('scope, alias')
        .in('scope', aliasLookupScopes)
    : { data: [] };
  const aliasByScope = new Map(
    (aliasRows ?? []).flatMap((row) =>
      row.alias ? [[String(row.scope), row.alias] as const] : []
    )
  );

  // Group by project home, projects first (by display label), General last.
  const groupMap = new Map<string | null, RuleCandidateItem[]>();
  for (const { groupScope, item } of built) {
    const bucket = groupMap.get(groupScope) ?? [];
    bucket.push(item);
    groupMap.set(groupScope, bucket);
  }
  const groupLabel = (scope: string | null): string =>
    scope === null
      ? t('rules.groupGeneral')
      : scopeOptionLabel(scope, aliasByScope.get(scope));
  const groups = [...groupMap.entries()]
    .map(([scope, items]) => ({ scope, label: groupLabel(scope), items }))
    .sort((a, b) => {
      if (a.scope === null) return 1;
      if (b.scope === null) return -1;
      return a.label.localeCompare(b.label);
    });

  const labels: RuleCandidateQueueLabels = {
    empty: t('rules.empty'),
    confidence: t('rules.confidence'),
    evidence: t('rules.evidence'),
    evidenceFirst: t('rules.evidenceFirst'),
    evidenceLast: t('rules.evidenceLast'),
    sourceMemory: t('rules.sourceMemory'),
    target: {
      user: t('rules.target.user'),
      project: t('rules.target.project'),
    },
    targetHint: {
      user: t('rules.targetHint.user'),
      project: t('rules.targetHint.project'),
    },
    actions: {
      promote: t('rules.actions.approve'),
      dismiss: t('rules.actions.dismiss'),
      snooze: t('rules.actions.snooze'),
      delete: t('rules.actions.delete'),
    },
    copy: t('rules.copy'),
    copied: t('rules.copied'),
    download: t('rules.download'),
    revoke: t('rules.revoke'),
    promotedBadge: t('rules.promotedBadge'),
    dismissedBadge: t('rules.dismissedBadge'),
    appliesTo: t('rules.appliesTo'),
    addressTo: t('rules.addressTo'),
    addressHint: t('rules.addressHint'),
    pin: t('rules.pin'),
    pinHint: t('rules.pinHint'),
    pinnedBadge: t('rules.pinnedBadge'),
    carriedFrom: t('rules.carriedFrom'),
  };

  const revokeLabels = {
    title: t('rules.revokeDialog.title'),
    description: t('rules.revokeDialog.description'),
    reasonLabel: t('rules.revokeDialog.reasonLabel'),
    reasonPlaceholder: t('rules.revokeDialog.reasonPlaceholder'),
    submit: t('rules.revokeDialog.submit'),
    submitPending: t('rules.revokeDialog.submitPending'),
    cancel: t('rules.revokeDialog.cancel'),
  };

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-semibold">{t('rules.title')}</h1>
            <Badge
              variant={(pendingCount ?? 0) > 0 ? 'amber' : 'secondary'}
              data-testid="rules-pending-count"
            >
              {t('rules.pendingCount', { count: pendingCount ?? 0 })}
            </Badge>
            {/* The killer metric: rules born from memory. */}
            <Badge variant="secondary" data-testid="rules-promoted-count">
              {t('rules.promotedCount', { count: promotedCount })}
            </Badge>
            {/* Delivery honesty: how many General rules actually ride the MCP
                instructions (the rest are promoted but silently undelivered). */}
            {deliveryTotal > 0 ? (
              // A link into the delivery facet: amber opens what is NOT
              // delivered, the problem the colour points at.
              <Link
                href={`/rules?status=promoted&delivery=${
                  deliveryTruncated ? 'undelivered' : 'delivered'
                }`}
                data-testid="rules-delivered-link"
              >
                <Badge
                  variant={deliveryTruncated ? 'amber' : 'secondary'}
                  data-testid="rules-delivered-count"
                  title={t('rules.deliveredHint')}
                >
                  {t('rules.deliveredCount', {
                    delivered: deliveredCount,
                    total: deliveryTotal,
                  })}
                </Badge>
              </Link>
            ) : null}
            {/* The guaranteed-delivery subset: pinned rules lead the
                briefing's rules[], exempt from the delivery cap and TTL. */}
            {pinnedCount > 0 ? (
              <Link
                href="/rules?status=promoted&pinned=pinned"
                data-testid="rules-pinned-link"
              >
                <Badge
                  variant="secondary"
                  data-testid="rules-pinned-count"
                  title={t('rules.pinnedCountHint')}
                >
                  {t('rules.pinnedCount', { count: pinnedCount })}
                </Badge>
              </Link>
            ) : null}
          </div>
          <p className="text-muted-foreground text-sm">
            {t('rules.description')}
          </p>
        </div>
        {/* The hygiene scan also runs rule-candidate detection (one pipeline). */}
        <ReviewScanButton
          labels={{
            scan: t('rules.scan.button'),
            scanning: t('review.scan.pending'),
            started: t('rules.scan.started'),
            modeQuick: t('review.scan.modeQuick'),
            modeFull: t('review.scan.modeFull'),
          }}
        />
      </div>

      <RulesFilter
        scope={generalSelected ? GENERAL_FILTER : (selectedScope ?? '')}
        status={selectedStatus}
        pinned={selectedPinned ?? ''}
        delivery={selectedDelivery ?? ''}
        pinnedOptions={[
          { value: 'pinned', label: t('rules.facet.pinned.pinned') },
          { value: 'unpinned', label: t('rules.facet.pinned.unpinned') },
        ]}
        deliveryOptions={[
          { value: 'delivered', label: t('rules.facet.delivery.delivered') },
          {
            value: 'undelivered',
            label: t('rules.facet.delivery.undelivered'),
          },
        ]}
        scopes={[
          ...(hasGeneral
            ? [{ value: GENERAL_FILTER, label: t('rules.groupGeneral') }]
            : []),
          ...availableScopes.map((scope) => ({
            value: scope,
            label: scopeOptionLabel(scope, aliasByScope.get(scope)),
          })),
        ]}
        statuses={[
          { value: 'all', label: t('rules.status.all') },
          { value: 'pending', label: t('rules.status.pending') },
          { value: 'promoted', label: t('rules.status.promoted') },
          { value: 'dismissed', label: t('rules.status.dismissed') },
        ]}
        labels={{
          allScopes: t('rules.filterAll'),
          pinnedAny: t('rules.facet.pinned.any'),
          deliveryAny: t('rules.facet.delivery.any'),
        }}
      />

      {listItems.length === 0 ? (
        <p data-testid="rules-empty" className="text-muted-foreground text-sm">
          {t('rules.empty')}
        </p>
      ) : (
        groups.map((group) => (
          <section
            key={group.scope ?? '__general__'}
            className="space-y-3"
            data-testid="rules-group"
          >
            <h2
              className={
                group.scope === null
                  ? 'text-muted-foreground text-sm font-medium'
                  : 'text-muted-foreground max-w-full truncate font-mono text-sm font-medium'
              }
              title={group.scope ?? undefined}
              data-testid="rules-group-heading"
            >
              {group.label}
            </h2>
            <RuleCandidateList
              items={group.items}
              labels={labels}
              revokeLabels={revokeLabels}
              deleteLabels={{
                title: t('rules.deleteDialog.title'),
                description: t('rules.deleteDialog.description'),
                confirm: t('rules.deleteDialog.confirm'),
                cancel: t('rules.deleteDialog.cancel'),
              }}
            />
          </section>
        ))
      )}
    </div>
  );
}
