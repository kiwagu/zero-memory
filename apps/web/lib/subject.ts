import { createServerSupabaseClient } from './supabase/server';

/**
 * The signed-in caller's own `usr_` id, or null for a guest.
 *
 * Derived from `getUser()` — which verifies the session against the auth
 * server — and then matched explicitly on `user_id`. Both halves matter: a
 * signed-in user can read their own profile and those of the people they
 * share a project with, so a query without that filter could return someone
 * else's row.
 */
export async function currentSubjectId(): Promise<string | null> {
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return null;
  }
  const { data } = await supabase
    .from('profiles')
    .select('id')
    .eq('user_id', user.id)
    .maybeSingle();
  return (data as { id: string } | null)?.id ?? null;
}
