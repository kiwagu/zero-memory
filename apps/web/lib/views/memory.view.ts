import type * as React from 'react';

import type { MemoryActionsLabels } from '@workspace/ui/components/memory/memory-actions';
import type { MemoryDetailData } from '@workspace/ui/components/memory/memory-detail';
import { scopeOptionLabel } from '@workspace/ui/lib/scope-format';

import type { MoveMemoryLabels } from '@/components/move-memory';
import type { PromoteToRuleLabels } from '@/components/promote-to-rule';
import type { SharedWith } from '@/components/shared-with';
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

/**
 * One memory as its view needs it — loaded once, under the viewer's session,
 * and rendered by the memory page or by a panel of the chain. Everything is
 * serializable: a panel receives it as JSON.
 */

const ROLE_VARIANTS = {
  admin: 'green',
  writer: 'blue',
  reader: 'secondary',
} as const;

/**
 * How many same-session siblings the section lists. The section answers "what
 * else came out of that conversation", which a first screenful settles; a
 * long-running session can produce dozens, and a wall of them would bury the
 * memory the page is actually about.
 */
const SAME_SESSION_LIMIT = 10;

/** How much of the text names the memory in a panel's header. */
const TITLE_LENGTH = 80;

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

export interface MemoryActionsData {
  memoryId: string;
  invalidated: boolean;
  currentScope: string;
  moveTargets: Array<{ value: string; label: string }>;
  writableScopes: string[];
  labels: {
    promote: PromoteToRuleLabels;
    move: MoveMemoryLabels;
    actions: MemoryActionsLabels;
  };
}

/** Only data: the members, the "you" marker and the dialog's copy. */
export type SharedWithData = React.ComponentProps<typeof SharedWith>;

export interface MemoryViewData {
  id: string;
  /** The memory's text, cut to one line — what names it in a panel. */
  title: string;
  detail: MemoryDetailData;
  /** The owner's actions; absent for anyone else. */
  actions: MemoryActionsData | null;
  /** Who the memory is shared with; absent for a private memory. */
  sharing: SharedWithData | null;
}

function toLinkedItems(links: LinkedMemory[]) {
  return links.map((link) => ({
    type: link.type,
    href: link.memory ? `/memory/${link.memory.id}` : undefined,
    preview: link.memory?.content,
  }));
}

function titleOf(content: string): string {
  const line = content.replace(/\s+/g, ' ').trim();
  return line.length > TITLE_LENGTH ? `${line.slice(0, TITLE_LENGTH)}…` : line;
}

export async function loadMemoryView(
  id: string
): Promise<MemoryViewData | null> {
  const supabase = await createServerSupabaseClient();
  const { t } = await getRequestMessages();

  const { data: memoryData } = await supabase
    .from('memories')
    .select(MEMORY_COLUMNS)
    .eq('id', id)
    .maybeSingle();
  if (!memoryData) {
    return null;
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
    .map((value) => ({ value, label: scopeOptionLabel(value) }));

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

  const lifecycle: MemoryDetailData['lifecycle'] = [
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
            value: memory.superseded_by,
            href: `/memory/${memory.superseded_by}`,
          },
        ]
      : []),
  ];

  const original = originalProps(memory, t);

  return {
    id: memory.id,
    title: titleOf(memory.content),
    detail: {
      id: memory.id,
      content: memory.content,
      original: original
        ? {
            text: original.text,
            lang: original.lang ?? null,
            toggle: original.label,
          }
        : null,
      badges: memoryBadges(memory, t, memberCount),
      validity: validityWindow(
        // valid_from defaults to now() at insert; created_at covers any
        // legacy row where the column is null.
        memory.valid_from ?? memory.created_at,
        memory.invalidated_at
      ),
      lifecycleTitle: t('memory.lifecycle'),
      lifecycle,
      versions:
        versionItems.length > 1
          ? {
              title: t('memory.versionHistory'),
              items: versionItems,
              currentLabel: t('memory.versionCurrent'),
              invalidatedLabel: t('memory.invalidated'),
            }
          : null,
      provenance: {
        title: t('memory.provenance'),
        entries: memory.source
          ? provenanceEntries(memory.source as Record<string, unknown>)
          : null,
        emptyLabel: t('memory.noSource'),
      },
      sameSession:
        sameSessionItems.length > 0
          ? {
              title: t('memory.sameSession', {
                count: sameSessionItems.length,
              }),
              items: sameSessionItems,
            }
          : null,
      entities: {
        title: t('memory.linkedEntities'),
        items: linkedEntities.flatMap((row) =>
          row.entities
            ? [
                {
                  href: `/entities/${row.entities.id}`,
                  name: row.entities.name,
                  type: row.entities.type,
                },
              ]
            : []
        ),
        emptyLabel: t('memory.noLinkedEntities'),
      },
      linksOut: {
        title: t('memory.linksOut', { count: linksOut.length }),
        items: toLinkedItems(linksOut),
        emptyLabel: t('memory.noLinksOut'),
      },
      linksIn: {
        title: t('memory.linksIn', { count: linksIn.length }),
        items: toLinkedItems(linksIn),
        emptyLabel: t('memory.noLinksIn'),
      },
      hiddenLabel: t('memory.linkHidden'),
      imageLabel: t('markdown.image'),
    },
    actions: isOwner
      ? {
          memoryId: memory.id,
          invalidated: Boolean(memory.invalidated_at),
          currentScope: String(memory.scope),
          moveTargets,
          writableScopes,
          labels: {
            promote: {
              promote: t('memory.actions.promoteToRule'),
              pending: t('memory.actions.promoteToRulePending'),
              done: t('memory.actions.promoteToRuleDone'),
              promoteAnyway: t('memory.actions.promoteToRuleAnyway'),
            },
            move: {
              move: t('memory.move.open'),
              title: t('memory.move.title'),
              description: t('memory.move.description'),
              targetPlaceholder: t('memory.move.target'),
              confirm: t('memory.move.confirm'),
              cancel: t('memory.move.cancel'),
              done: t('memory.move.done'),
            },
            actions: {
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
            },
          },
        }
      : null,
    sharing: isShared
      ? {
          members: memberItems,
          youLabel: t('scopes.you'),
          labels: {
            button: t('memory.sharedWith.button'),
            title: t('memory.sharedWith.title'),
            description: t('memory.sharedWith.description'),
            empty: t('memory.sharedWith.empty'),
          },
        }
      : null,
  };
}
