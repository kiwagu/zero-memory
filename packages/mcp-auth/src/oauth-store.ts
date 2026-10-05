/**
 * Port: persistence of the OAuth authorization server (clients, pending
 * authorizations, stored consents and one-time authorization codes). The
 * Supabase adapter runs with the service role — every table is deny-all under
 * RLS — so this port must never be reachable from user-controlled code paths
 * other than the OAuth endpoints.
 *
 * People are identified by their Auth user id (the `sub` of their session),
 * as the endpoints know them; mapping to the domain id is the adapter's job.
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
  /**
   * What /token hands out on redemption: the agent's Supabase access token
   * and the authorization server's own refresh token for the grant.
   */
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
}

export type OAuthAuthorizationStatus = 'pending' | 'approved' | 'denied';

/**
 * A validated authorization request parked while the person signs in to the
 * dashboard and decides. Who it is bound to stays inside the store: the
 * endpoints only ever ask "for this person", never read it back.
 */
export interface OAuthAuthorizationRecord {
  id: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  state: string | null;
  resource: string | null;
  scope: string;
  status: OAuthAuthorizationStatus;
  expiresAt: Date;
}

export type NewOAuthAuthorization = Omit<
  OAuthAuthorizationRecord,
  'id' | 'status'
>;

export interface OAuthConsentRecord {
  scope: string;
  /** The return address the person saw when they approved. */
  redirectUri: string;
}

/**
 * A person's approval of one client as the authorization server carries it
 * between refreshes: the Auth session it stands for now, and the generation
 * of the refresh token last handed to the client.
 */
export interface AgentGrantRecord {
  id: string;
  authUserId: string;
  clientId: string;
  scope: string;
  generation: number;
  /** Signs the refresh tokens of this grant (see grant-token). */
  tokenSecret: string;
  /** The access token last handed out, for a refresh that raced it. */
  accessToken: string;
  accessExpiresAt: Date;
  authRefreshToken: string;
  sessionId: string;
  credentialsFingerprint: string;
  rotatedAt: Date;
  revokedAt: Date | null;
}

export type NewAgentGrant = Omit<
  AgentGrantRecord,
  'id' | 'generation' | 'rotatedAt' | 'revokedAt'
>;

/** What a refresh writes when it moves a grant to its next generation. */
export interface AgentGrantRenewal {
  accessToken: string;
  accessExpiresAt: Date;
  authRefreshToken: string;
  sessionId: string;
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

  /** Parks a validated request as pending; the store assigns the `oaa_` id. */
  insertAuthorization(
    authorization: NewOAuthAuthorization
  ): Promise<OAuthAuthorizationRecord>;

  /**
   * Binds a pending, unexpired authorization to the first person who opens
   * it and returns it — to that person, every time. Anyone else, and any
   * request that is decided, expired or unknown, gets null. Atomic: two
   * concurrent first readers cannot both win.
   */
  bindAuthorization(
    id: string,
    authUserId: string,
    now: Date
  ): Promise<OAuthAuthorizationRecord | null>;

  /**
   * Atomically moves a pending, unexpired authorization bound to this person
   * to approved or denied. Null when it is not theirs, not pending, or
   * expired — so a decision is taken exactly once.
   */
  decideAuthorization(
    id: string,
    authUserId: string,
    status: Exclude<OAuthAuthorizationStatus, 'pending'>,
    now: Date
  ): Promise<OAuthAuthorizationRecord | null>;

  /** Housekeeping: drops authorizations whose TTL elapsed. */
  deleteExpiredAuthorizations(now: Date): Promise<void>;

  /**
   * Records a session the authorization server opened for an agent, at the
   * moment it is minted and before anyone can hold it. The record is what
   * tells that session apart from a person's own sign-in that has not given
   * its second factor: a recorded session reaches the data without one.
   */
  recordAgentSession(session: {
    sessionId: string;
    authUserId: string;
    clientId: string;
  }): Promise<void>;

  /** Forgets the record of an agent session Auth has ended. */
  forgetAgentSession(sessionId: string): Promise<void>;

  /** Ends every live grant this person gave this client. */
  revokeClientGrants(
    authUserId: string,
    clientId: string,
    now: Date
  ): Promise<void>;

  /** Stores a new grant; the store assigns the `agg_` id. */
  insertGrant(grant: NewAgentGrant): Promise<AgentGrantRecord>;

  findGrant(id: string): Promise<AgentGrantRecord | null>;

  /**
   * Moves a live grant from `fromGeneration` to the next one, with the
   * session it now stands for. False when the grant is revoked or another
   * refresh moved it first: exactly one refresh wins each generation.
   */
  advanceGrant(
    id: string,
    fromGeneration: number,
    renewal: AgentGrantRenewal,
    now: Date
  ): Promise<boolean>;

  /** Ends a grant for good. */
  revokeGrant(id: string, now: Date): Promise<void>;

  /**
   * A digest of the account's password and verified second factors; null for
   * an unknown account. A grant is renewed only while it is unchanged.
   */
  credentialsFingerprint(authUserId: string): Promise<string | null>;

  /** The person's live (not revoked) consent for this client, if any. */
  findConsent(
    authUserId: string,
    clientId: string
  ): Promise<OAuthConsentRecord | null>;

  /**
   * Records, or renews, the person's consent for this client: the scope they
   * approved and the return address they approved it for.
   */
  upsertConsent(
    authUserId: string,
    clientId: string,
    scope: string,
    redirectUri: string
  ): Promise<void>;
}
