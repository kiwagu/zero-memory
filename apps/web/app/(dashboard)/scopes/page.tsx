import Link from 'next/link';

import { Alert, AlertDescription } from '@workspace/ui/components/alert';
import { Badge } from '@workspace/ui/components/badge';
import { DetailSection } from '@workspace/ui/components/common/detail-section';
import { EmptyState } from '@workspace/ui/components/common/empty-state';
import { FeedPagination } from '@workspace/ui/components/memory/feed-pagination';
import { MemberList } from '@workspace/ui/components/scope/member-list';

import { RemoveMemberButton } from '@/components/remove-member-button';
import { ScopeControls } from '@/components/scope-controls';
import { AddMemberForm, CreateScopeForm } from '@/components/scope-forms';
import { ScopeExportButton } from '@/components/scope-export-button';
import { getRequestMessages } from '@/lib/i18n';
import {
  PAGE_SIZE,
  SCOPE_ROLES,
  formatTimestamp,
  roleLabel,
} from '@/lib/memory';
import { loadIdentityMap, memberLabel } from '@/lib/scope-members';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { currentUserEntityId } from '@/lib/user';

type Membership = {
  scope: string;
  user_id: string;
  role: string;
  granted_by: string | null;
  created_at: string;
  accepted_at: string | null;
  invited_email: string | null;
};

const ROLE_VARIANTS = {
  admin: 'green',
  writer: 'blue',
  reader: 'secondary',
} as const;

export default async function ScopesPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string }>;
}) {
  const page = Math.max(
    1,
    Number.parseInt((await searchParams).page ?? '1', 10) || 1
  );
  const supabase = await createServerSupabaseClient();
  const [userEntityId, { data: memberData, error }, identityByUserId] =
    await Promise.all([
      currentUserEntityId(supabase),
      supabase
        .from('scope_members')
        .select(
          'scope, user_id, role, granted_by, created_at, accepted_at, invited_email'
        )
        .order('created_at', { ascending: true }),
      loadIdentityMap(supabase),
    ]);
  // usr_ handle: scope_members.user_id is usr_, not the auth uuid.
  const userId = userEntityId ?? '';
  const { t } = await getRequestMessages();

  // Full path on purpose: here the scope IS the subject, not a chip — this is
  // the one page where the collapsed badge form would hide the answer.
  const memberships = (memberData ?? []).map((row) => ({
    ...row,
    scope: String(row.scope),
  })) as Membership[];

  const byScope = new Map<string, Membership[]>();
  for (const membership of memberships) {
    const existing = byScope.get(membership.scope) ?? [];
    existing.push(membership);
    byScope.set(membership.scope, existing);
  }
  const scopes = [...byScope.entries()].sort(([a], [b]) => a.localeCompare(b));
  const totalPages = Math.max(1, Math.ceil(scopes.length / PAGE_SIZE));
  const offset = (page - 1) * PAGE_SIZE;
  const pageScopes = scopes.slice(offset, offset + PAGE_SIZE);

  // Memory count per shown scope (RLS-scoped head counts, one per card).
  const countByScope = new Map<string, number>();
  await Promise.all(
    pageScopes.map(async ([scope]) => {
      const { count } = await supabase
        .from('memories')
        .select('id', { count: 'exact', head: true })
        .eq('scope', scope);
      countByScope.set(scope, count ?? 0);
    })
  );

  // Display metadata (alias + description) of the shown scopes.
  const { data: metaRows } = await supabase
    .from('scopes')
    .select('scope, alias, description')
    .in(
      'scope',
      pageScopes.map(([scope]) => scope)
    );
  const metaByScope = new Map(
    (metaRows ?? []).map((row) => [
      String(row.scope),
      { alias: row.alias, description: row.description },
    ])
  );

  // Merge targets: every OTHER scope this user administers.
  const adminScopes = memberships
    .filter((row) => row.user_id === userId && row.role === 'admin')
    .map((row) => row.scope);

  // A pending invitee's identity deliberately does NOT resolve — that is the
  // point of the consent model. What the admin may see is the address they
  // themselves typed, carried on the row; falling back to a truncated id keeps
  // the list readable for rows that predate the column.
  const displayUser = (member: Membership) =>
    memberLabel(identityByUserId.get(member.user_id)) ??
    member.invited_email ??
    `${member.user_id.slice(0, 8)}…`;

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <h1 className="text-xl font-semibold">{t('scopes.title')}</h1>

      {error ? (
        <Alert variant="destructive">
          <AlertDescription>
            {t('scopes.loadError', { message: error.message })}
          </AlertDescription>
        </Alert>
      ) : null}

      <DetailSection title={t('scopes.newScope')}>
        <CreateScopeForm
          labels={{
            placeholder: t('scopes.create.placeholder'),
            submit: t('scopes.create.submit'),
            submitPending: t('scopes.create.submitPending'),
            hint: t('scopes.create.hint'),
          }}
        />
      </DetailSection>

      {scopes.length === 0 ? (
        <EmptyState className="rounded-xl border border-dashed">
          {t('scopes.empty')}
        </EmptyState>
      ) : null}

      {pageScopes.map(([scope, members]) => {
        const isAdmin = members.some(
          (member) => member.user_id === userId && member.role === 'admin'
        );
        const meta = metaByScope.get(scope);
        // The card title links to the memory feed pre-filtered to this scope
        // (the feed reads the `scope` query param).
        const feedHref = `/memories?scope=${encodeURIComponent(scope)}`;
        const mergeTargets = adminScopes
          .filter((candidate) => candidate !== scope)
          .map((candidate) => ({
            value: candidate,
            label: metaByScope.get(candidate)?.alias ?? candidate,
          }));
        return (
          <section
            key={scope}
            className="rounded-xl border bg-card p-4 text-card-foreground shadow-sm"
          >
            {/* min-w-0 + break-all: an arbitrarily long ltree path wraps
                inside the card instead of stretching past its edge. */}
            <div className="mb-3 flex items-start justify-between gap-2">
              <div className="min-w-0 flex-1">
                {meta?.alias ? (
                  <>
                    <h2 className="text-sm font-semibold">
                      <Link
                        href={feedHref}
                        data-testid="scope-feed-link"
                        className="hover:underline"
                      >
                        {meta.alias}
                      </Link>
                    </h2>
                    <p className="text-muted-foreground font-mono text-xs break-all">
                      {scope}
                    </p>
                  </>
                ) : (
                  <h2 className="font-mono text-sm font-semibold break-all">
                    <Link
                      href={feedHref}
                      data-testid="scope-feed-link"
                      className="hover:underline"
                    >
                      {scope}
                    </Link>
                  </h2>
                )}
              </div>
              <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
                <Badge variant="secondary">
                  {t('scopes.memoryCount', {
                    count: countByScope.get(scope) ?? 0,
                  })}
                </Badge>
                {isAdmin ? (
                  <Badge variant="green">{t('scopes.youAreAdmin')}</Badge>
                ) : null}
                <ScopeExportButton
                  scope={scope}
                  labels={{
                    label: t('scopes.export.label'),
                    title: t('scopes.export.title'),
                    confirmTitle: t('scopes.export.confirmTitle'),
                    confirmBody: t('scopes.export.confirmBody'),
                    confirm: t('scopes.export.confirm'),
                    cancel: t('scopes.export.cancel'),
                  }}
                />
                {isAdmin ? (
                  <ScopeControls
                    scope={scope}
                    alias={meta?.alias ?? null}
                    description={meta?.description ?? null}
                    mergeTargets={mergeTargets}
                    labels={{
                      menu: t('scopes.controls.menu'),
                      editMeta: t('scopes.controls.editMeta'),
                      rename: t('scopes.controls.rename'),
                      merge: t('scopes.controls.merge'),
                      delete: t('scopes.controls.delete'),
                      metaTitle: t('scopes.controls.metaTitle'),
                      aliasLabel: t('scopes.controls.aliasLabel'),
                      aliasPlaceholder: t('scopes.controls.aliasPlaceholder'),
                      descriptionLabel: t('scopes.controls.descriptionLabel'),
                      descriptionPlaceholder: t(
                        'scopes.controls.descriptionPlaceholder'
                      ),
                      generate: t('scopes.controls.generate'),
                      generatePending: t('scopes.controls.generatePending'),
                      renameTitle: t('scopes.controls.renameTitle'),
                      renameHint: t('scopes.controls.renameHint'),
                      mergeTitle: t('scopes.controls.mergeTitle'),
                      mergeBody: t('scopes.controls.mergeBody'),
                      mergeTargetPlaceholder: t(
                        'scopes.controls.mergeTargetPlaceholder'
                      ),
                      deleteTitle: t('scopes.controls.deleteTitle'),
                      deleteBody: t('scopes.controls.deleteBody'),
                      deleteAlternative: t('scopes.controls.deleteAlternative'),
                      save: t('scopes.controls.save'),
                      confirm: t('scopes.controls.confirm'),
                      cancel: t('scopes.controls.cancel'),
                      pending: t('scopes.controls.pending'),
                    }}
                  />
                ) : null}
              </div>
            </div>
            {meta?.description ? (
              <p className="text-muted-foreground mb-3 line-clamp-3 text-sm">
                {meta.description}
              </p>
            ) : null}
            <MemberList
              youLabel={t('scopes.you')}
              items={members.map((member) => ({
                key: `${member.scope}:${member.user_id}`,
                name: displayUser(member),
                isYou: member.user_id === userId,
                roleLabel: roleLabel(member.role, t),
                statusLabel:
                  member.accepted_at === null
                    ? t('scopes.member.pending')
                    : undefined,
                roleVariant:
                  ROLE_VARIANTS[member.role as keyof typeof ROLE_VARIANTS] ??
                  'secondary',
                timestamp: formatTimestamp(member.created_at),
                // Admins can revoke anyone but themselves (self-revoke would
                // risk orphaning the scope's last admin).
                action:
                  isAdmin && member.user_id !== userId ? (
                    <RemoveMemberButton
                      scope={scope}
                      userId={member.user_id}
                      labels={{
                        button: t('scopes.removeMember.button'),
                        confirmTitle: t('scopes.removeMember.confirmTitle'),
                        confirmBody: t('scopes.removeMember.confirmBody', {
                          member: displayUser(member),
                        }),
                        confirm: t('scopes.removeMember.confirm'),
                        cancel: t('scopes.removeMember.cancel'),
                      }}
                    />
                  ) : undefined,
              }))}
            />
            {isAdmin ? (
              <div className="mt-3 border-t pt-3">
                <AddMemberForm
                  scope={scope}
                  labels={{
                    emailPlaceholder: t('scopes.addMember.emailPlaceholder'),
                    submit: t('scopes.addMember.submit'),
                    submitPending: t('scopes.addMember.submitPending'),
                  }}
                  roles={SCOPE_ROLES.map((value) => ({
                    value,
                    label: roleLabel(value, t),
                  }))}
                />
              </div>
            ) : null}
          </section>
        );
      })}

      {totalPages > 1 ? (
        <FeedPagination
          linkComponent={Link}
          newerHref={page > 1 ? scopesPageHref(page - 1) : undefined}
          olderHref={page < totalPages ? scopesPageHref(page + 1) : undefined}
          pageLabel={t('scopes.pager.page', { page, total: totalPages })}
          newerLabel={t('scopes.pager.prev')}
          olderLabel={t('scopes.pager.next')}
        />
      ) : null}
    </div>
  );
}

const scopesPageHref = (page: number): string =>
  page > 1 ? `/scopes?page=${page}` : '/scopes';
