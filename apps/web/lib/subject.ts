import { createServerSupabaseClient } from './supabase/server';

/**
 * The signed-in caller's own `usr_` id, or null for a guest.
 *
 * Derived from `getUser()` — which verifies the session against the auth
 * server — and then matched explicitly on `user_id`. Both halves matter: the
 * profiles table is readable by any signed-in user, so a query without that
 * filter would return everybody's rows, not the caller's.
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
