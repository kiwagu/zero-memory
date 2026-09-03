import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@workspace/db';

export type Client = SupabaseClient<Database>;

export interface SupabaseEnv {
  url: string;
  anonKey: string;
}

/** Fail fast on missing configuration — no silent fallbacks. */
export const resolveSupabaseEnv = (): SupabaseEnv => {
  const url = process.env.SUPABASE_URL;
  const anonKey = process.env.SUPABASE_ANON_KEY;
  if (!url || !anonKey) {
    throw new Error(
      'SUPABASE_URL and SUPABASE_ANON_KEY must be set in the environment.'
    );
  }
  return { url, anonKey };
};

/**
 * Client acting AS the user: anon key plus the user's JWT as bearer token,
 * so every query runs under that user's RLS policies.
 */
export const createUserClient = (accessToken: string): Client => {
  const { url, anonKey } = resolveSupabaseEnv();
  return createClient<Database>(url, anonKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
  });
};

/** Plain anon client (used for password sign-in / token refresh). */
export const createAnonClient = (): Client => {
  const { url, anonKey } = resolveSupabaseEnv();
  return createClient<Database>(url, anonKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });
};

/**
 * Privileged client (service-role key): bypasses RLS entirely. Use ONLY for
 * operational tables that are deny-all to end users (e.g. usage_events) — never
 * to serve user-facing reads/writes, which must stay under the caller's JWT and
 * RLS. Fails fast when the service-role key is absent — no silent fallback.
 */
export const createServiceRoleClient = (): Client => {
  const url = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceRoleKey) {
    throw new Error(
      'SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in the ' +
        'environment.'
    );
  }
  return createClient<Database>(url, serviceRoleKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });
};
