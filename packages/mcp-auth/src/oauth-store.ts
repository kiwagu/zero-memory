/**
 * Port: persistence of the OAuth authorization server (clients + one-time
 * authorization codes). The Supabase adapter runs with the service role —
 * both tables are deny-all under RLS — so this port must never be reachable
 * from user-controlled code paths other than the OAuth endpoints.
 */

export interface OAuthClientRecord {
  clientId: string;
  clientName: string | null;
  redirectUris: string[];
  tokenEndpointAuthMethod: string;
}

export interface OAuthCodeRecord {
  code: string;
  clientId: string;
  userId: string;
  codeChallenge: string;
  redirectUri: string;
  resource: string | null;
  /** Supabase session captured at login, returned by /token on redemption. */
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
}

export interface IOAuthStore {
  /** Registers a client; the store assigns the client_id. */
  insertClient(
    client: Omit<OAuthClientRecord, 'clientId'>
  ): Promise<OAuthClientRecord>;

  findClient(clientId: string): Promise<OAuthClientRecord | null>;

  insertCode(record: OAuthCodeRecord): Promise<void>;

  /**
   * Atomically claims an authorization code: removes it and returns the
   * record when it existed, was unused, and had not expired — null otherwise.
   * Single-use is enforced HERE (delete-returning), not by the caller.
   */
  consumeCode(code: string): Promise<OAuthCodeRecord | null>;

  /** Housekeeping: drops codes whose TTL elapsed without redemption. */
  deleteExpiredCodes(now: Date): Promise<void>;
}
