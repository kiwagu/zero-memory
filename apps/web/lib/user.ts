import type { createServerSupabaseClient } from './supabase/server';

/**
 * The caller's `usr_` entity id (`public.profiles.id`) — the domain user handle
 * stored by the usr_-native columns `owner_id`, `invalidated_by`, `shared_by`,
 * and `scope_members.user_id`. Resolved from the auth uuid (`claims.sub`) via
 * `profiles`; the caller can always read their own profile row, so the lookup
 * always resolves for a signed-in caller.
 *
 * Use this — never the raw `claims.sub` uuid — whenever comparing to or writing
 * a domain user column: those columns carry a CHECK that rejects a non-usr_
 * value, and comparing a uuid to a usr_ column silently matches nothing.
 */
export async function currentUserEntityId(
  supabase: Awaited<ReturnType<typeof createServerSupabaseClient>>
): Promise<string | null> {
  const { data } = await supabase.auth.getClaims();
  const authId = data?.claims.sub;
  if (!authId) {
    return null;
  }
  const { data: profile } = await supabase
    .from('profiles')
    .select('id')
    .eq('user_id', authId)
    .single();
  return profile?.id ?? null;
}
