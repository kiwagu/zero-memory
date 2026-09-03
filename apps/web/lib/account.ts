import type { createServerSupabaseClient } from './supabase/server';

/** How the signed-in account is addressed and named on screen. */
export interface Account {
  /** The address the account signs in with. Empty when there are no claims. */
  email: string;
  /** The name the account chose, or '' when it never set one. */
  name: string;
  /** What the chrome shows: the chosen name, else the address's local part. */
  displayName: string;
}

/** Reads a display name out of auth metadata, tolerating either spelling. */
function metadataName(claims: Record<string, unknown>): string {
  const metadata = claims.user_metadata;
  if (typeof metadata !== 'object' || metadata === null) {
    return '';
  }
  const record = metadata as Record<string, unknown>;
  const value = record.name ?? record.full_name;
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * The signed-in account as the dashboard shows it.
 *
 * The name comes from auth `user_metadata` — where the profile panel writes it
 * — and travels in the JWT, so reading it costs nothing beyond the claims call
 * the layout already makes. Falling back to the address's local part means an
 * account that never opened settings still gets a human-looking label instead
 * of a blank space.
 */
export async function currentAccount(
  supabase: Awaited<ReturnType<typeof createServerSupabaseClient>>
): Promise<Account> {
  const { data } = await supabase.auth.getClaims();
  const claims = (data?.claims ?? {}) as Record<string, unknown>;
  const email = typeof claims.email === 'string' ? claims.email : '';
  const name = metadataName(claims);
  return {
    email,
    name,
    displayName: name || email.split('@')[0] || '',
  };
}
