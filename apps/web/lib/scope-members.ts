import type { createServerSupabaseClient } from '@/lib/supabase/server';

type ServerClient = Awaited<ReturnType<typeof createServerSupabaseClient>>;

/** A membership row of a scope, RLS-scoped to what the caller may read. */
export type ScopeMember = {
  user_id: string;
  role: string;
  created_at: string;
  /** null while the invitation is unaccepted: the row confers nothing yet. */
  accepted_at: string | null;
};

/** How another member is shown: the name they chose, else their address. */
export type MemberIdentity = { name: string; email: string };

/**
 * `usr_` entity id → identity map, keyed the way the domain columns store
 * users. Identities come from `scope_member_identities`, which answers under
 * the caller's own JWT and covers exactly the people the caller may already
 * resolve: themselves and the members of scopes they share or administer.
 * Degrades to an empty map (callers fall back to raw ids) when the RPC fails.
 * Shared by the /scopes page and the memory detail's "shared with" readout.
 *
 * Deliberately NOT the service-role account listing this used to be: that
 * pulled every account on the instance — with every address — to label a
 * handful of members, and its page ceiling silently truncated the answer for a
 * large enough instance. Both problems end with the roster.
 */
export async function loadIdentityMap(
  supabase: ServerClient
): Promise<Map<string, MemberIdentity>> {
  const { data, error } = await supabase.rpc('scope_member_identities');
  if (error) {
    return new Map();
  }
  return new Map(
    (data ?? []).flatMap((row) => {
      const email = row.email ?? '';
      if (!email) {
        return [];
      }
      return [
        [
          String(row.user_id),
          { name: (row.display_name ?? '').trim(), email },
        ] as const,
      ];
    })
  );
}

/** What to print for a member: their name, else their address. */
export function memberLabel(
  identity: MemberIdentity | undefined
): string | null {
  if (!identity) {
    return null;
  }
  return identity.name || identity.email;
}

/**
 * Member count per scope for the given scopes, in ONE RLS-scoped query. Used to
 * tell a truly shared memory (scope has members beyond the owner) from a merely
 * sharable one (owner alone). A scope absent from the returned map has no
 * readable members (treat as not shared). Empty input skips the query.
 *
 * Counts ACCEPTED memberships only. A pending invitation confers nothing, so
 * counting it would make the card announce a memory as "shared" with someone
 * who cannot read it and may never accept — the badge exists precisely to tell
 * capability from fact, and that reading would be a lie in the fact direction.
 */
export async function loadScopeMemberCounts(
  supabase: ServerClient,
  scopes: readonly string[]
): Promise<Map<string, number>> {
  const distinct = [...new Set(scopes)];
  if (distinct.length === 0) {
    return new Map();
  }
  const { data } = await supabase
    .from('scope_members')
    .select('scope')
    .in('scope', distinct)
    .not('accepted_at', 'is', null);
  const counts = new Map<string, number>();
  for (const row of data ?? []) {
    const scope = String(row.scope);
    counts.set(scope, (counts.get(scope) ?? 0) + 1);
  }
  return counts;
}

/**
 * The members of a single scope (RLS-scoped), oldest first — the "who is this
 * shared with" list. Returns an empty array when the caller cannot read the
 * scope's membership.
 */
export async function loadScopeMembers(
  supabase: ServerClient,
  scope: string
): Promise<ScopeMember[]> {
  const { data } = await supabase
    .from('scope_members')
    .select('user_id, role, created_at, accepted_at')
    .eq('scope', scope)
    .order('created_at', { ascending: true });
  return (data ?? []) as ScopeMember[];
}
