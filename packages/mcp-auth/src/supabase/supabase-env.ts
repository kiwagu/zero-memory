/**
 * Supabase configuration the adapters read. Fail fast when it is missing — no
 * silent fallbacks.
 */

export const resolveAnonEnv = (): { url: string; anonKey: string } => {
  const url = process.env.SUPABASE_URL;
  const anonKey = process.env.SUPABASE_ANON_KEY;
  if (!url || !anonKey) {
    throw new Error(
      'SUPABASE_URL and SUPABASE_ANON_KEY must be set in the environment.'
    );
  }
  return { url, anonKey };
};

export const resolveServiceEnv = (): {
  url: string;
  serviceRoleKey: string;
} => {
  const url = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceRoleKey) {
    throw new Error(
      'SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in the ' +
        'environment.'
    );
  }
  return { url, serviceRoleKey };
};

/** Every adapter call is a one-shot exchange: nothing persisted or refreshed. */
export const ONE_SHOT_AUTH = {
  persistSession: false,
  autoRefreshToken: false,
  detectSessionInUrl: false,
} as const;
