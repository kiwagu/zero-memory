import {
  createClient,
  type Session,
  type SupabaseClient,
} from '@supabase/supabase-js';
import { createLogger } from '@workspace/logger';

import type { AuthSession, IAuthGateway } from '../auth-gateway.js';
import {
  ONE_SHOT_AUTH,
  resolveAnonEnv,
  resolveServiceEnv,
} from './supabase-env.js';

const DEFAULT_EXPIRES_IN_SECONDS = 3600;

const toAuthSession = (session: Session): AuthSession => ({
  userId: session.user.id,
  email: session.user.email,
  accessToken: session.access_token,
  refreshToken: session.refresh_token,
  expiresIn: session.expires_in ?? DEFAULT_EXPIRES_IN_SECONDS,
  sessionId: sessionIdOf(session.access_token),
});

/** The claims of a token Auth has already verified; none when unreadable. */
const claimsOf = (accessToken: string): Record<string, unknown> => {
  try {
    const payload: unknown = JSON.parse(
      Buffer.from(accessToken.split('.')[1] ?? '', 'base64url').toString('utf8')
    );
    return payload !== null && typeof payload === 'object'
      ? (payload as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
};

/** The `aal` claim of a token Auth has already verified. */
const assuranceLevelOf = (accessToken: string): string | undefined => {
  const aal = claimsOf(accessToken).aal;
  return typeof aal === 'string' ? aal : undefined;
};

/** The `session_id` claim: Auth's id of the session the token belongs to. */
const sessionIdOf = (accessToken: string): string | null => {
  const id = claimsOf(accessToken).session_id;
  return typeof id === 'string' && id !== '' ? id : null;
};

/**
 * Supabase Auth adapter for the identity gateway. Token checks and refresh
 * go through an anon-key client; minting a session for a user needs
 * the service role, because only an administrator may issue a sign-in on a
 * user's behalf.
 */
export interface SupabaseAuthGatewayClients {
  /** A one-shot anon-key client (token checks, redemption, refresh). */
  anon: () => SupabaseClient;
  /** A one-shot service-role client (minting on a user's behalf). */
  service: () => SupabaseClient;
}

const defaultClients: SupabaseAuthGatewayClients = {
  anon: () => {
    const { url, anonKey } = resolveAnonEnv();
    return createClient(url, anonKey, { auth: ONE_SHOT_AUTH });
  },
  service: () => {
    const { url, serviceRoleKey } = resolveServiceEnv();
    return createClient(url, serviceRoleKey, { auth: ONE_SHOT_AUTH });
  },
};

export class SupabaseAuthGateway implements IAuthGateway {
  readonly #logger = createLogger(SupabaseAuthGateway.name);
  readonly #clients: SupabaseAuthGatewayClients;

  constructor(clients: SupabaseAuthGatewayClients = defaultClients) {
    this.#clients = clients;
  }

  async verifyAccessToken(
    accessToken: string
  ): Promise<{ userId: string; owesSecondFactor: boolean } | null> {
    const { data, error } = await this.#anon().auth.getUser(accessToken);
    if (error || !data.user) {
      return null;
    }
    const hasFactor = (data.user.factors ?? []).some(
      (factor) => factor.status === 'verified'
    );
    // Auth has just accepted this token, so its claims can be read as given.
    return {
      userId: data.user.id,
      owesSecondFactor: hasFactor && assuranceLevelOf(accessToken) !== 'aal2',
    };
  }

  /**
   * An administrator-issued one-time sign-in, redeemed on the spot: the link
   * is generated (nothing is mailed) and its hashed token is verified at once,
   * which opens a fresh session of its own for the user.
   *
   * The link is addressed by email, and an email can move between accounts —
   * or, for a deleted account, make Auth create a new one — between the
   * lookup and the link. So the user is pinned twice, on the link and on the
   * session it opens; a session that belongs to anyone else is never returned,
   * and revoking it is attempted on the spot (best effort: a failed revocation
   * is logged, and the session's tokens never leave this method either way).
   */
  async revokeSession(session: AuthSession): Promise<void> {
    const revoked = await this.#service()
      .auth.admin.signOut(session.accessToken, 'local')
      .catch((thrown: unknown) => ({
        error: {
          message: thrown instanceof Error ? thrown.message : 'thrown',
        },
      }));
    if (revoked.error) {
      this.#logger.warn('session revoke: ending the minted session failed', {
        error: revoked.error.message,
      });
    }
  }

  async mintSession(userId: string): Promise<AuthSession | null> {
    const admin = this.#service().auth.admin;
    const { data: found, error: findError } = await admin.getUserById(userId);
    const email = found.user?.email;
    if (findError || !email) {
      this.#logger.warn('session mint: user not found or has no email', {
        error: findError?.message,
      });
      return null;
    }
    const { data: link, error: linkError } = await admin.generateLink({
      type: 'magiclink',
      email,
    });
    const tokenHash = link.properties?.hashed_token;
    if (linkError || !tokenHash) {
      this.#logger.warn('session mint: sign-in link refused', {
        error: linkError?.message,
      });
      return null;
    }
    if (link.user?.id !== userId) {
      this.#logger.warn('session mint: sign-in link names another user');
      return null;
    }
    const { data: verified, error: verifyError } =
      await this.#anon().auth.verifyOtp({
        type: 'magiclink',
        token_hash: tokenHash,
      });
    if (verifyError || !verified.session) {
      this.#logger.warn('session mint: sign-in link not redeemed', {
        error: verifyError?.message,
      });
      return null;
    }
    if (verified.session.user.id !== userId) {
      this.#logger.warn(
        'session mint: redeemed session belongs to another user'
      );
      const revoked = await admin
        .signOut(verified.session.access_token, 'local')
        .catch((thrown: unknown) => ({
          error: {
            message: thrown instanceof Error ? thrown.message : 'thrown',
          },
        }));
      if (revoked.error) {
        this.#logger.warn('session mint: revoking that session failed', {
          error: revoked.error.message,
        });
      }
      return null;
    }
    return toAuthSession(verified.session);
  }

  async refreshSession(refreshToken: string): Promise<AuthSession | null> {
    const { data, error } = await this.#anon().auth.refreshSession({
      refresh_token: refreshToken,
    });
    if (error || !data.session) {
      this.#logger.warn('refresh token rejected', { error: error?.message });
      return null;
    }
    return toAuthSession(data.session);
  }

  #anon(): SupabaseClient {
    return this.#clients.anon();
  }

  #service(): SupabaseClient {
    return this.#clients.service();
  }
}
