import { createClient } from '@supabase/supabase-js';
import type { Database } from '@workspace/db';

import { serverSupabaseEnvironment } from './env';

/**
 * Service-role admin client. SERVER ONLY — used exclusively for resolving
 * member emails to user ids (GoTrue admin API). Never import from a client
 * component; the guard below makes an accidental leak fail loudly.
 *
 * Returns null when SUPABASE_SERVICE_ROLE_KEY is not configured so callers
 * can degrade gracefully (raw user ids instead of emails).
 */
export function createAdminClient() {
  if (typeof window !== 'undefined') {
    throw new Error('createAdminClient must never run in the browser.');
  }
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceRoleKey) {
    return null;
  }
  const { url } = serverSupabaseEnvironment();
  return createClient<Database>(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
