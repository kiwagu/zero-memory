import { entityIdSchemas } from '@workspace/contracts';

import type {
  IOAuthStore,
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

  /** The agent sessions recorded so far, for tests. */
  agentSessions(): ReadonlyMap<
    string,
    { authUserId: string; clientId: string }
  > {
    return this.#agentSessions;
  }
}
