/**
 * Port: the identity provider behind the authorization server. This AS mints
 * no tokens of its own — a session IS a Supabase session, so the gateway
 * returns the provider's access/refresh pair verbatim.
 */

export interface AuthSession {
  userId: string;
  email?: string;
  accessToken: string;
  refreshToken: string;
  /** Seconds until the access token expires. */
  expiresIn: number;
}

export interface IAuthGateway {
  /** Password login; null on invalid credentials (never throws for that). */
  signInWithPassword(
    email: string,
    password: string
  ): Promise<AuthSession | null>;

  /** Rotates a refresh token; null when it is invalid/revoked. */
  refreshSession(refreshToken: string): Promise<AuthSession | null>;
}
