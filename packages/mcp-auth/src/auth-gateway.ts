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
  /**
   * The provider's id of this session (the `session_id` claim), the same on
   * every token the session issues, refreshes included. Null when the token
   * carried none.
   */
  sessionId: string | null;
}

export interface IAuthGateway {
  /**
   * Who holds this bearer token: the Auth user id behind a live session, and
   * whether that session still owes its second factor — the account has a
   * verified one and the session has not presented the code (below `aal2`).
   * Null when the token is not a live session (never throws for that).
   */
  verifyAccessToken(
    accessToken: string
  ): Promise<{ userId: string; owesSecondFactor: boolean } | null>;

  /**
   * A NEW session for this Auth user, independent of any session they hold
   * elsewhere: signing out of the dashboard does not end it, and ending it
   * does not sign them out of the dashboard. Null when it cannot be minted.
   */
  mintSession(userId: string): Promise<AuthSession | null>;

  /** Rotates a refresh token; null when it is invalid/revoked. */
  refreshSession(refreshToken: string): Promise<AuthSession | null>;

  /**
   * Ends a session this gateway minted that nobody will ever hold, because
   * the steps after minting failed. Best effort: a failure is logged, never
   * thrown.
   */
  revokeSession(session: AuthSession): Promise<void>;
}
