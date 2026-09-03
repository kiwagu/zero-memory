import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { createLogger } from '@workspace/logger';

import type { AuthSession, IAuthGateway } from '../auth-gateway.js';

const DEFAULT_EXPIRES_IN_SECONDS = 3600;

/** Fail fast on missing configuration — no silent fallbacks. */
const resolveAnonEnv = (): { url: string; anonKey: string } => {
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
 * Supabase Auth adapter for the identity gateway: anon-key client, no
 * persisted session (every call is a one-shot exchange).
 */
export class SupabaseAuthGateway implements IAuthGateway {
  readonly #logger = createLogger(SupabaseAuthGateway.name);

  async signInWithPassword(
    email: string,
    password: string
  ): Promise<AuthSession | null> {
    const { data, error } = await this.#client().auth.signInWithPassword({
      email,
      password,
    });
    if (error || !data.session) {
      this.#logger.warn('password sign-in rejected', {
        error: error?.message,
      });
      return null;
    }
    return {
      userId: data.session.user.id,
      email: data.session.user.email,
      accessToken: data.session.access_token,
      refreshToken: data.session.refresh_token,
      expiresIn: data.session.expires_in ?? DEFAULT_EXPIRES_IN_SECONDS,
    };
  }

  async refreshSession(refreshToken: string): Promise<AuthSession | null> {
    const { data, error } = await this.#client().auth.refreshSession({
      refresh_token: refreshToken,
    });
    if (error || !data.session) {
      this.#logger.warn('refresh token rejected', { error: error?.message });
      return null;
    }
    return {
      userId: data.session.user.id,
      email: data.session.user.email,
      accessToken: data.session.access_token,
      refreshToken: data.session.refresh_token,
      expiresIn: data.session.expires_in ?? DEFAULT_EXPIRES_IN_SECONDS,
    };
  }

  #client(): SupabaseClient {
    const { url, anonKey } = resolveAnonEnv();
    return createClient(url, anonKey, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false,
      },
    });
  }
}
