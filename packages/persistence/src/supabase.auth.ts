import type { Session } from '@supabase/supabase-js';
import { createLogger } from '@workspace/logger';

import { createAnonClient } from './supabase.client.js';

export interface AuthCredentials {
  email: string;
  password: string;
}

/** Reads the service-account credentials; fails fast when unset. */
export const resolveAuthCredentialsFromEnv = (): AuthCredentials => {
  const email = process.env.ZM_EMAIL;
  const password = process.env.ZM_PASSWORD;
  if (!email || !password) {
    throw new Error('ZM_EMAIL and ZM_PASSWORD must be set in the environment.');
  }
  return { email, password };
};

/** Refresh this many seconds before the access token expires. */
const EXPIRY_MARGIN_SECONDS = 60;

export interface AuthenticatedUser {
  userId: string;
  email?: string;
  accessToken: string;
}

/**
 * Password sign-in for the local/solo deployment. Keeps the session and
 * transparently refreshes the access token shortly before it expires.
 */
export class SupabaseSessionManager {
  readonly #logger = createLogger(SupabaseSessionManager.name);
  readonly #credentials: AuthCredentials;
  #session: Session | null = null;

  constructor(credentials: AuthCredentials = resolveAuthCredentialsFromEnv()) {
    this.#credentials = credentials;
  }

  async signIn(): Promise<Session> {
    const client = createAnonClient();
    const { data, error } = await client.auth.signInWithPassword(
      this.#credentials
    );
    if (error || !data.session) {
      throw new Error(
        `Supabase sign-in failed: ${error?.message ?? 'no session'}`
      );
    }
    this.#session = data.session;
    this.#logger.info('signed in', { userId: data.session.user.id });
    return data.session;
  }

  /** Valid session, refreshed when close to expiry. */
  async getSession(): Promise<Session> {
    if (!this.#session) {
      return this.signIn();
    }
    const expiresAt = this.#session.expires_at ?? 0;
    const now = Math.floor(Date.now() / 1000);
    if (expiresAt - now > EXPIRY_MARGIN_SECONDS) {
      return this.#session;
    }
    const client = createAnonClient();
    const { data, error } = await client.auth.refreshSession({
      refresh_token: this.#session.refresh_token,
    });
    if (error || !data.session) {
      this.#logger.warn('token refresh failed, re-signing in', {
        error: error?.message,
      });
      return this.signIn();
    }
    this.#session = data.session;
    return data.session;
  }

  async getAuthenticatedUser(): Promise<AuthenticatedUser> {
    const session = await this.getSession();
    return {
      userId: session.user.id,
      email: session.user.email,
      accessToken: session.access_token,
    };
  }
}
