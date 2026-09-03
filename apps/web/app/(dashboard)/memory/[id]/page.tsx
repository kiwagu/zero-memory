import Link from 'next/link';
import { notFound } from 'next/navigation';

import { DescriptionList } from '@workspace/ui/components/common/description-list';
import { DetailSection } from '@workspace/ui/components/common/detail-section';
import { EntityChipList } from '@workspace/ui/components/entity/entity-chip-list';
import { LinkedMemoryList } from '@workspace/ui/components/memory/linked-memory-list';
import { MemoryBadges } from '@workspace/ui/components/memory/memory-card';
import { MemoryVersionList } from '@workspace/ui/components/memory/memory-version-list';
import { OriginalDisclosure } from '@workspace/ui/components/memory/original-disclosure';

import { MemoryActions } from '@/components/memory-actions';
import { MoveMemory } from '@/components/move-memory';
import { PromoteToRule } from '@/components/promote-to-rule';
import { scopeDisplay } from '@workspace/ui/lib/scope-format';
import { SharedWith } from '@/components/shared-with';
import { getRequestMessages } from '@/lib/i18n';
import {
  MEMORY_COLUMNS,
  formatTimestamp,
  kindLabel,
  memoryBadges,
  originalProps,
  roleLabel,
  scopeLabel,
  type MemoryRow,
} from '@/lib/memory';
import { memoryThreadToken, provenanceEntries } from '@/lib/provenance-view';
import {
  loadIdentityMap,
  loadScopeMembers,
  memberLabel,
  type MemberIdentity,
} from '@/lib/scope-members';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { currentUserEntityId } from '@/lib/user';

const ROLE_VARIANTS = {
  admin: 'green',
  writer: 'blue',
  reader: 'secondary',
} as const;

type LinkedEntity = {
  entity_id: string;
  entities: { id: string; name: string; type: string; scope: unknown } | null;
};

type LinkedMemory = {
  type: string;
  created_at: string;
  memory: { id: string; content: string; kind: string } | null;
};

/** A sibling fact born in the same conversation as the memory on screen. */
type SameSessionRow = {
  id: string;
  content: string;
  kind: string;
  created_at: string;
};

/**
 * How many same-session siblings the section lists. The section answers "what
 * else came out of that conversation", which a first screenful settles; a
 * long-running session can produce dozens, and a wall of them would bury the
 * memory the page is actually about.
 */
const SAME_SESSION_LIMIT = 10;

function toLinkedItems(links: LinkedMemory[]) {
  return links.map((link) => ({
    type: link.type,
    href: link.memory ? `/memory/${link.memory.id}` : undefined,
    preview: link.memory?.content,
  }));
}

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
  const supabase = await createServerSupabaseClient();
  const { t } = await getRequestMessages();

  const { data: memoryData } = await supabase
    .from('memories')
    .select(MEMORY_COLUMNS)
    .eq('id', id)
    .maybeSingle();
  if (!memoryData) {
    notFound();
  }
  const memory = memoryData as unknown as MemoryRow;

  const userId = (await currentUserEntityId(supabase)) ?? '';
  const isOwner = memory.owner_id === userId;

  // Targets for the manual move: the owner's project-scope memberships
  // (RLS-scoped). The component hides itself when there is nowhere to move.
  const { data: moveScopeRows } = isOwner
    ? await supabase.from('scope_members').select('scope')
    : { data: [] as Array<{ scope: unknown }> };
  const moveTargets = [
    ...new Set(
      (moveScopeRows ?? [])
        .map((row) => String(row.scope))
        .filter((value) => value.startsWith('proj.'))
    ),
  ]
    .sort()
    .map((value) => ({ value, label: scopeDisplay(value) }));

  // The session marker: the conversation this memory was born in, when it has
  // one. A write outside any conversation (import, repo bootstrap, terminal
  // capture, a dashboard action) legitimately carries none.
  const threadToken = memoryThreadToken(
    memory.source as Record<string, unknown> | null
  );

  const [
    entitiesResult,
    linksOutResult,
    linksInResult,
    scopesResult,
    versionsResult,
    sameSessionResult,
  ] = await Promise.all([
    supabase
      .from('memory_entities')
      .select('entity_id, entities(id, name, type, scope)')
      .eq('memory_id', id),
    supabase
      .from('memory_links')
      .select(
        'type, created_at, memory:memories!memory_links_dst_fkey(id, content, kind)'
      )
      .eq('src', id),
    supabase
      .from('memory_links')
      .select(
        'type, created_at, memory:memories!memory_links_src_fkey(id, content, kind)'
      )
      .eq('dst', id),
    supabase
      .from('scope_members')
      .select('scope, role')
      .eq('user_id', userId)
      .in('role', ['writer', 'admin']),
    supabase.rpc('memory_version_history', { p_id: id }),
    // Other facts out of the same conversation. RLS is the only fence needed:
    // the query names no owner, so it returns exactly what this viewer may
    // already see elsewhere in the dashboard. Capped — the point is "there was
    // more in that session", not an exhaustive listing.
    threadToken
      ? supabase
          .from('memories')
          .select('id, content, kind, created_at')
          .filter('source->>thread', 'eq', threadToken)
          .neq('id', id)
          .order('created_at', { ascending: true })
          .limit(SAME_SESSION_LIMIT)
      : Promise.resolve({ data: [] as SameSessionRow[] }),
  ]);

  const linkedEntities = (entitiesResult.data ?? []) as LinkedEntity[];
  const linksOut = (linksOutResult.data ?? []) as unknown as LinkedMemory[];
  const linksIn = (linksInResult.data ?? []) as unknown as LinkedMemory[];
  // A validity window, Zep-bitemporal style: "Valid <from> — <to|present>".
  const validityWindow = (from: string | null, to: string | null): string =>
    t('memory.validity.window', {
      from: from ? formatTimestamp(from) : '—',
      to: to ? formatTimestamp(to) : t('memory.validity.present'),
    });

  // RLS-filtered supersession lineage (oldest first); only worth a section
  // when the memory actually has other versions than itself. Each row shows
  // its validity window instead of a bare creation timestamp.
  const versions = versionsResult.data ?? [];
  const versionItems = versions.map((version) => ({
    href: `/memory/${version.id}`,
    preview: version.content,
    timestamp: validityWindow(version.created_at, version.invalidated_at),
    kindLabel: kindLabel(version.kind, t),
    isCurrent: version.is_current,
    invalidated: Boolean(version.invalidated_at),
  }));
  const writableScopes = [
    ...new Set((scopesResult.data ?? []).map((row) => scopeLabel(row.scope))),
  ];
  // Presented with each sibling's KIND as its badge: the relation here is
  // "born in the same conversation", so a relation-type badge would overstate
  // what is known about the pair.
  const sameSessionItems = (
    (sameSessionResult.data ?? []) as SameSessionRow[]
  ).map((row) => ({
    type: kindLabel(row.kind, t),
    href: `/memory/${row.id}`,
    preview: row.content,
  }));

  // Sharing honesty: a `shared`-visibility memory is only TRULY shared when its
  // scope has members beyond the owner. Resolve the scope's members (+ names)
  // to both drive the badge (shared vs sharable) and populate the "shared with"
  // dialog. Skipped entirely for private memories.
  const isShared = memory.visibility === 'shared';
  const [allScopeMembers, identityByUserId] = isShared
    ? await Promise.all([
        loadScopeMembers(supabase, String(memory.scope)),
        loadIdentityMap(supabase),
      ])
    : [[], new Map<string, MemberIdentity>()];
  // "Shared with" answers who can SEE this memory, so a pending invitation does
  // not belong in it: that person has accepted nothing and reads nothing yet.
  // Listing them would overstate the memory's reach — the opposite of what this
  // readout is for.
  const scopeMembers = allScopeMembers.filter(
    (member) => member.accepted_at !== null
  );
  const memberCount = isShared ? scopeMembers.length : undefined;
  const displayUser = (uid: string) =>
    memberLabel(identityByUserId.get(uid)) ?? `${uid.slice(0, 8)}…`;
  const memberItems = scopeMembers.map((member) => ({
    key: `${String(memory.scope)}:${member.user_id}`,
    name: displayUser(member.user_id),
    isYou: member.user_id === userId,
    roleLabel: roleLabel(member.role, t),
    roleVariant:
      ROLE_VARIANTS[member.role as keyof typeof ROLE_VARIANTS] ?? 'secondary',
    timestamp: formatTimestamp(member.created_at),
  }));

  const lifecycleItems = [
    { label: t('memory.created'), value: formatTimestamp(memory.created_at) },
    {
      label: t('memory.validFrom'),
      value: formatTimestamp(memory.valid_from),
    },
    { label: t('memory.owner'), value: memory.owner_id },
    ...(memory.shared_at
      ? [
          {
            label: t('memory.sharedAt'),
            value: formatTimestamp(memory.shared_at),
          },
          { label: t('memory.sharedBy'), value: memory.shared_by ?? '—' },
        ]
      : []),
    ...(memory.invalidated_at
      ? [
          {
            label: t('memory.invalidatedAt'),
            value: formatTimestamp(memory.invalidated_at),
          },
          {
            label: t('memory.invalidatedBy'),
            // Human/agent paths set invalidated_by (usr_); a system invalidation
            // has none, so fall back to the recorded actor + judge model.
            value:
              memory.invalidated_by ??
              (memory.invalidated_by_agent
                ? memory.invalidated_by_model
                  ? `${memory.invalidated_by_agent} · ${memory.invalidated_by_model}`
                  : memory.invalidated_by_agent
                : '—'),
          },
        ]
      : []),
    ...(memory.superseded_by
      ? [
          {
            label: t('memory.supersededBy'),
            value: (
              <Link
                href={`/memory/${memory.superseded_by}`}
                className="hover:underline"
              >
                {memory.superseded_by}
              </Link>
            ),
          },
        ]
      : []),
  ];

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <Link
        href={backToFeedHref}
        className="text-sm text-muted-foreground hover:underline"
      >
        {t('memory.backToFeed')}
      </Link>

      <article
        data-testid="memory-detail-content"
        className="rounded-xl border bg-card p-5 text-card-foreground shadow-sm"
      >
        <div
          data-testid="memory-id"
          className="mb-3 font-mono text-xs break-all text-muted-foreground select-all"
        >
          {memory.id}
        </div>
        <p className="text-sm leading-relaxed whitespace-pre-wrap">
          {memory.content}
        </p>
        {(() => {
          const original = originalProps(memory, t);
          return original ? (
            <OriginalDisclosure
              text={original.text}
              lang={original.lang}
              labels={{ toggle: original.label }}
            />
          ) : null;
        })()}
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <MemoryBadges badges={memoryBadges(memory, t, memberCount)} />
          {isShared ? (
            <SharedWith
              members={memberItems}
              youLabel={t('scopes.you')}
              labels={{
                button: t('memory.sharedWith.button'),
                title: t('memory.sharedWith.title'),
                description: t('memory.sharedWith.description'),
                empty: t('memory.sharedWith.empty'),
              }}
            />
          ) : null}
        </div>
        <p
          data-testid="memory-validity"
          className="mt-3 text-xs text-muted-foreground"
        >
          {validityWindow(
            // valid_from defaults to now() at insert; created_at covers any
            // legacy row where the column is null.
            memory.valid_from ?? memory.created_at,
            memory.invalidated_at
          )}
        </p>
      </article>

      {/* One action row: share/forget, promote, move — every owner action on
          the memory sits together and wraps only when the viewport forces it,
          instead of stacking one control per line. */}
      {isOwner ? (
        <div className="flex flex-wrap items-start gap-2">
          {!memory.invalidated_at ? (
            <PromoteToRule
              memoryId={memory.id}
              labels={{
                promote: t('memory.actions.promoteToRule'),
                pending: t('memory.actions.promoteToRulePending'),
                done: t('memory.actions.promoteToRuleDone'),
                promoteAnyway: t('memory.actions.promoteToRuleAnyway'),
              }}
            />
          ) : null}
          {!memory.invalidated_at ? (
            <MoveMemory
              memoryId={memory.id}
              currentScope={String(memory.scope)}
              projectScopes={moveTargets}
              labels={{
                move: t('memory.move.open'),
                title: t('memory.move.title'),
                description: t('memory.move.description'),
                targetPlaceholder: t('memory.move.target'),
                confirm: t('memory.move.confirm'),
                cancel: t('memory.move.cancel'),
                done: t('memory.move.done'),
              }}
            />
          ) : null}
          <MemoryActions
            memoryId={memory.id}
            invalidated={Boolean(memory.invalidated_at)}
            writableScopes={writableScopes}
            labels={{
              share: t('memory.actions.share'),
              shareTitle: t('memory.actions.shareTitle'),
              customScopeOption: t('memory.actions.customScopeOption'),
              customScopePlaceholder: t(
                'memory.actions.customScopePlaceholder'
              ),
              shareSubmit: t('memory.actions.shareSubmit'),
              shareSubmitPending: t('memory.actions.shareSubmitPending'),
              forget: t('memory.actions.forget'),
              forgetConfirmTitle: t('memory.actions.forgetConfirmTitle'),
              forgetConfirmDescription: t(
                'memory.actions.forgetConfirmDescription'
              ),
              forgetConfirm: t('memory.actions.forgetConfirm'),
              cancel: t('memory.actions.cancel'),
            }}
          />
        </div>
      ) : null}

      <DetailSection title={t('memory.lifecycle')}>
        <DescriptionList className="text-sm" items={lifecycleItems} />
      </DetailSection>

      {versionItems.length > 1 ? (
        <DetailSection
          title={t('memory.versionHistory')}
          data-testid="memory-version-history"
        >
          <MemoryVersionList
            linkComponent={Link}
            items={versionItems}
            currentLabel={t('memory.versionCurrent')}
            invalidatedLabel={t('memory.invalidated')}
          />
        </DetailSection>
      ) : null}

      <DetailSection
        title={t('memory.provenance')}
        data-testid="memory-provenance"
      >
        {memory.source ? (
          <dl className="bg-muted overflow-x-auto rounded-md p-3 font-mono text-xs">
            {provenanceEntries(memory.source as Record<string, unknown>).map(
              (entry) => (
                <div key={entry.key} className="flex gap-2 py-0.5">
                  <dt className="text-muted-foreground shrink-0">
                    {entry.key}
                  </dt>
                  <dd className="break-all" title={entry.full}>
                    {entry.display}
                  </dd>
                </div>
              )
            )}
          </dl>
        ) : (
          <p className="text-sm text-muted-foreground">
            {t('memory.noSource')}
          </p>
        )}
      </DetailSection>

      {sameSessionItems.length > 0 ? (
        <DetailSection
          title={t('memory.sameSession', { count: sameSessionItems.length })}
          data-testid="memory-same-session"
        >
          {/* A TEMPORAL neighbourhood, not a semantic one: these facts were
              written in the same conversation, which is why the section says
              "same session" rather than "related" — typed links remain the
              only claim that two memories are about each other. */}
          <LinkedMemoryList
            linkComponent={Link}
            items={sameSessionItems}
            hiddenLabel={t('memory.linkHidden')}
          />
        </DetailSection>
      ) : null}

      <DetailSection title={t('memory.linkedEntities')}>
        {linkedEntities.length > 0 ? (
          <EntityChipList
            linkComponent={Link}
            items={linkedEntities.flatMap((row) =>
              row.entities
                ? [
                    {
                      href: `/entities?q=${encodeURIComponent(row.entities.name)}`,
                      name: row.entities.name,
                      type: row.entities.type,
                    },
                  ]
                : []
            )}
          />
        ) : (
          <p className="text-sm text-muted-foreground">
            {t('memory.noLinkedEntities')}
          </p>
        )}
      </DetailSection>

      <DetailSection title={t('memory.linksOut', { count: linksOut.length })}>
        {linksOut.length > 0 ? (
          <LinkedMemoryList
            linkComponent={Link}
            items={toLinkedItems(linksOut)}
            hiddenLabel={t('memory.linkHidden')}
          />
        ) : (
          <p className="text-sm text-muted-foreground">
            {t('memory.noLinksOut')}
          </p>
        )}
      </DetailSection>

      <DetailSection title={t('memory.linksIn', { count: linksIn.length })}>
        {linksIn.length > 0 ? (
          <LinkedMemoryList
            linkComponent={Link}
            items={toLinkedItems(linksIn)}
            hiddenLabel={t('memory.linkHidden')}
          />
        ) : (
          <p className="text-sm text-muted-foreground">
            {t('memory.noLinksIn')}
          </p>
        )}
      </DetailSection>
    </div>
  );
}
