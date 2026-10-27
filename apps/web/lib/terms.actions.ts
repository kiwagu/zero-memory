'use server';

import { redirect } from 'next/navigation';

import { legalLinks } from './legal';
import { safeNext } from './safe-next';
import { createServerSupabaseClient } from './supabase/server';

type AcceptResult = { ok: false; error: string };

/**
 * Records the caller's acceptance of this instance's documents on their own
 * auth account — the same place and shape a password sign-up writes it — and
 * sends them on to where they were going.
 *
 * The claims the dashboard gates on travel in the JWT, and a metadata update
 * does not re-issue the token on its own: without the refresh that follows,
 * the layout would read the old claims and send the person straight back
 * here. Redirecting throws inside a server action by design, so the function
 * only ever RETURNS a failure.
 */
export async function acceptTerms(next: string): Promise<AcceptResult> {
  const legal = legalLinks();
  if (!legal.required) {
    redirect('/');
  }
  const supabase = await createServerSupabaseClient();
  const { error } = await supabase.auth.updateUser({
    data: {
      terms_accepted_at: new Date().toISOString(),
      ...(legal.version ? { terms_version: legal.version } : {}),
    },
  });
  if (error) {
    return { ok: false, error: error.message };
  }
  const { error: refreshError } = await supabase.auth.refreshSession();
  if (refreshError) {
    return { ok: false, error: refreshError.message };
  }
  redirect(safeNext(next));
}
