import { createBrowserClient } from '@supabase/ssr';
import type { Database } from '@workspace/db';

import { readBrowserSupabaseConfig, supabaseAuthCookieName } from './env';

/**
 * Cookie-backed browser client. `createBrowserClient` dedupes to a singleton
 * internally, so calling this per component is safe.
 *
 * The Supabase URL and key come from the document, not from build-time inlined
 * constants — that is what lets one published image serve any deployment.
 */
export function createClient() {
  const { url, anonKey } = readBrowserSupabaseConfig(document, {
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  });

  return createBrowserClient<Database>(url, anonKey, {
    cookieOptions: {
      name: supabaseAuthCookieName(url),
    },
  });
}
