import { entityIdSchemas } from '@workspace/contracts';

import type {
  IOAuthStore,
  OAuthClientRecord,
  OAuthCodeRecord,
} from './oauth-store.js';

/** In-memory OAuth store for unit tests (mirrors the adapter semantics). */
export class InMemoryOAuthStore implements IOAuthStore {
  readonly #clients = new Map<string, OAuthClientRecord>();
  readonly #codes = new Map<string, OAuthCodeRecord>();

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
}
