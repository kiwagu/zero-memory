import { entityIdSchemas } from '@workspace/contracts';

import type {
  AgentGrantRecord,
  AgentGrantRenewal,
  IOAuthStore,
  NewAgentGrant,
  NewOAuthAuthorization,
  OAuthAuthorizationRecord,
  OAuthAuthorizationStatus,
  OAuthClientRecord,
  OAuthCodeRecord,
  OAuthConsentRecord,
} from './oauth-store.js';

interface StoredAuthorization extends OAuthAuthorizationRecord {
  boundTo: string | null;
}

const toAuthorizationRecord = ({
  boundTo: _boundTo,
  ...record
}: StoredAuthorization): OAuthAuthorizationRecord => ({ ...record });

const isLive = (row: StoredAuthorization, now: Date): boolean =>
  row.status === 'pending' && row.expiresAt.getTime() > now.getTime();

/** In-memory OAuth store for unit tests (mirrors the adapter semantics). */
export class InMemoryOAuthStore implements IOAuthStore {
  readonly #clients = new Map<string, OAuthClientRecord>();
  readonly #codes = new Map<string, OAuthCodeRecord>();
  readonly #authorizations = new Map<string, StoredAuthorization>();
  readonly #consents = new Map<string, OAuthConsentRecord>();
  readonly #agentSessions = new Map<
    string,
    { authUserId: string; clientId: string }
  >();
  readonly #grants = new Map<string, AgentGrantRecord>();
  readonly #fingerprints = new Map<string, string>();

  async insertClient(
    client: Omit<OAuthClientRecord, 'clientId'>
  ): Promise<OAuthClientRecord> {
    const record: OAuthClientRecord = {
      ...client,
      clientId: entityIdSchemas.oauth_client.create(),
    };
    this.#clients.set(record.clientId, record);
    return record;
  }

  async findClient(clientId: string): Promise<OAuthClientRecord | null> {
    return this.#clients.get(clientId) ?? null;
  }

  async insertCode(record: OAuthCodeRecord): Promise<void> {
    this.#codes.set(record.code, { ...record });
  }

  async consumeCode(code: string): Promise<OAuthCodeRecord | null> {
    const record = this.#codes.get(code);
    if (!record || record.expiresAt.getTime() <= Date.now()) {
      return null;
    }
    this.#codes.delete(code);
    return record;
  }

  async deleteExpiredCodes(now: Date): Promise<void> {
    for (const [code, record] of this.#codes) {
      if (record.expiresAt.getTime() <= now.getTime()) {
        this.#codes.delete(code);
      }
    }
  }

  async insertAuthorization(
    authorization: NewOAuthAuthorization
  ): Promise<OAuthAuthorizationRecord> {
    const row: StoredAuthorization = {
      ...authorization,
      id: entityIdSchemas.oauth_authorization.create(),
      status: 'pending',
      boundTo: null,
    };
    this.#authorizations.set(row.id, row);
    return toAuthorizationRecord(row);
  }

  async bindAuthorization(
    id: string,
    authUserId: string,
    now: Date
  ): Promise<OAuthAuthorizationRecord | null> {
    const row = this.#authorizations.get(id);
    if (!row || !isLive(row, now)) {
      return null;
    }
    if (row.boundTo !== null && row.boundTo !== authUserId) {
      return null;
    }
    row.boundTo = authUserId;
    return toAuthorizationRecord(row);
  }

  async decideAuthorization(
    id: string,
    authUserId: string,
    status: Exclude<OAuthAuthorizationStatus, 'pending'>,
    now: Date
  ): Promise<OAuthAuthorizationRecord | null> {
    const row = this.#authorizations.get(id);
    if (!row || !isLive(row, now) || row.boundTo !== authUserId) {
      return null;
    }
    row.status = status;
    return toAuthorizationRecord(row);
  }

  async deleteExpiredAuthorizations(now: Date): Promise<void> {
    for (const [id, row] of this.#authorizations) {
      if (row.expiresAt.getTime() <= now.getTime()) {
        this.#authorizations.delete(id);
      }
    }
  }

  async findConsent(
    authUserId: string,
    clientId: string
  ): Promise<OAuthConsentRecord | null> {
    const consent = this.#consents.get(`${authUserId} ${clientId}`);
    return consent ? { ...consent } : null;
  }

  async upsertConsent(
    authUserId: string,
    clientId: string,
    scope: string,
    redirectUri: string
  ): Promise<void> {
    this.#consents.set(`${authUserId} ${clientId}`, { scope, redirectUri });
  }

  async recordAgentSession(session: {
    sessionId: string;
    authUserId: string;
    clientId: string;
  }): Promise<void> {
    this.#agentSessions.set(session.sessionId, {
      authUserId: session.authUserId,
      clientId: session.clientId,
    });
  }

  async forgetAgentSession(sessionId: string): Promise<void> {
    this.#agentSessions.delete(sessionId);
  }

  async revokeClientGrants(
    authUserId: string,
    clientId: string,
    now: Date
  ): Promise<void> {
    for (const grant of this.#grants.values()) {
      if (
        grant.authUserId === authUserId &&
        grant.clientId === clientId &&
        grant.revokedAt === null
      ) {
        grant.revokedAt = now;
      }
    }
  }

  async insertGrant(grant: NewAgentGrant): Promise<AgentGrantRecord> {
    const record: AgentGrantRecord = {
      ...grant,
      id: entityIdSchemas.agent_grant.create(),
      generation: 0,
      rotatedAt: new Date(),
      revokedAt: null,
    };
    this.#grants.set(record.id, record);
    return { ...record };
  }

  async findGrant(id: string): Promise<AgentGrantRecord | null> {
    const grant = this.#grants.get(id);
    return grant ? { ...grant } : null;
  }

  async advanceGrant(
    id: string,
    fromGeneration: number,
    renewal: AgentGrantRenewal,
    now: Date
  ): Promise<boolean> {
    const grant = this.#grants.get(id);
    if (
      !grant ||
      grant.revokedAt !== null ||
      grant.generation !== fromGeneration
    ) {
      return false;
    }
    Object.assign(grant, renewal, {
      generation: fromGeneration + 1,
      rotatedAt: now,
    });
    return true;
  }

  async revokeGrant(id: string, now: Date): Promise<void> {
    const grant = this.#grants.get(id);
    if (grant && grant.revokedAt === null) {
      grant.revokedAt = now;
    }
  }

  async credentialsFingerprint(authUserId: string): Promise<string | null> {
    return this.#fingerprints.get(authUserId) ?? 'initial-credentials';
  }

  /** Makes the account's credentials read as changed, for tests. */
  changeCredentials(authUserId: string): void {
    this.#fingerprints.set(
      authUserId,
      `changed-${Date.now()}-${Math.random()}`
    );
  }

  /** Withdraws the person's consent, for tests. */
  withdrawConsent(authUserId: string, clientId: string): void {
    this.#consents.delete(`${authUserId} ${clientId}`);
  }

  /** The agent sessions recorded so far, for tests. */
  agentSessions(): ReadonlyMap<
    string,
    { authUserId: string; clientId: string }
  > {
    return this.#agentSessions;
  }
}
