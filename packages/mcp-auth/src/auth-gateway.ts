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
  /**
   * Who holds this bearer token: the Auth user id behind a live session, or
   * null when the token is not one (never throws for that).
   */
  verifyAccessToken(accessToken: string): Promise<{ userId: string } | null>;

  /**
   * A NEW session for this Auth user, independent of any session they hold
   * elsewhere: signing out of the dashboard does not end it, and ending it
   * does not sign them out of the dashboard. Null when it cannot be minted.
   */
  mintSession(userId: string): Promise<AuthSession | null>;

  /** Password login; null on invalid credentials (never throws for that). */
  signInWithPassword(
    email: string,
    password: string
  ): Promise<AuthSession | null>;

  /** Rotates a refresh token; null when it is invalid/revoked. */
  refreshSession(refreshToken: string): Promise<AuthSession | null>;
}
