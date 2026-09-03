'use server';

import { NAME_MAX_LENGTH } from '@workspace/ui/components/settings/profile-panel';

import { createServerSupabaseClient } from './supabase/server';

/** What the panel gets back: a success, or a reason to show the user. */
type SaveResult = { ok: true } | { ok: false; error: string };

/**
 * Stores the caller's display name on their own auth account.
 *
 * The name lives in auth `user_metadata`, not in `profiles`: that table is
 * deliberately free of personal data and is readable by every authenticated
 * user, so a name column there would publish everyone's name to everyone.
 * Metadata is written by the caller's own session — no service-role client is
 * involved — and rides along in the JWT the dashboard already reads.
 *
 * An empty value CLEARS the name rather than storing a blank one, so the
 * dashboard falls back to the address's local part.
 */
export async function saveDisplayName(name: string): Promise<SaveResult> {
  const trimmed = name.trim();
  if (trimmed.length > NAME_MAX_LENGTH) {
    return {
      ok: false,
      error: `A name may be at most ${NAME_MAX_LENGTH} characters.`,
    };
  }
  // Reject control characters: the name is rendered as chrome on every screen,
  // and a newline or a bidi override there would garble the layout.
  if (/[\p{Cc}\p{Cf}]/u.test(trimmed)) {
    return { ok: false, error: 'A name may not contain control characters.' };
  }

  const supabase = await createServerSupabaseClient();
  const { error } = await supabase.auth.updateUser({
    data: { name: trimmed === '' ? null : trimmed },
  });
  if (error) {
    return { ok: false, error: error.message };
  }

  // The name is read back off the session's JWT, and the cookie still holds the
  // token minted BEFORE this write — so without a refresh the dashboard would
  // keep showing the old name (or the fallback) until the token expired on its
  // own. Refreshing mints a token carrying the new metadata and the SSR client
  // writes it back to the cookie.
  const { error: refreshError } = await supabase.auth.refreshSession();
  if (refreshError) {
    return { ok: false, error: refreshError.message };
  }
  return { ok: true };
}
