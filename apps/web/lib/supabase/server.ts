import { createServerClient } from '@supabase/ssr';
import type { Database } from '@workspace/db';
import { cookies, headers } from 'next/headers';

import { secureCookies } from '@/lib/supabase/cookie-security';

import { serverSupabaseEnvironment } from './env';

/**
 * Cookie-bridged server client — new instance per call (serverless safe).
 * Runs every query as the signed-in user, so RLS is the enforcement boundary.
 */
export async function createServerSupabaseClient() {
  const cookieStore = await cookies();
  const secure = secureCookies(await headers());
  const { url, anonKey, authCookieName } = serverSupabaseEnvironment();

  return createServerClient<Database>(url, anonKey, {
    cookieOptions: {
      name: authCookieName,
      secure,
    },
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          cookiesToSet.forEach(({ name, value, options }) =>
            cookieStore.set(name, value, options)
          );
        } catch {
          // Server Component without mutable cookies; proxy refresh applies.
        }
      },
    },
  });
}
