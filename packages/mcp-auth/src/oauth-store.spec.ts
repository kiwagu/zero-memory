import { beforeEach, describe, expect, it } from 'vitest';

import { InMemoryOAuthStore } from './in-memory-oauth-store.js';
import type { NewOAuthAuthorization } from './oauth-store.js';
import { MCP_SCOPES } from './oauth.schema.js';

/**
 * The store port's contract for pending authorizations and consents, held by
 * the in-memory adapter the handler tests run on. The Supabase adapter keeps
 * the same semantics with conditional updates; the api e2e walks it.
 */
const ALICE = '00000000-0000-4000-8000-00000000000a';
const BOB = '00000000-0000-4000-8000-00000000000b';
const NOW = new Date('2026-10-03T12:00:00Z');
const LATER = new Date('2026-10-03T12:05:00Z');
const EXPIRY = new Date('2026-10-03T12:10:00Z');
const AFTER_EXPIRY = new Date('2026-10-03T12:10:01Z');

describe('pending authorizations', () => {
  let store: InMemoryOAuthStore;
  let request: NewOAuthAuthorization;

  beforeEach(async () => {
    store = new InMemoryOAuthStore();
    const client = await store.insertClient({
      clientName: 'zm-test',
      redirectUris: ['http://127.0.0.1/callback'],
      tokenEndpointAuthMethod: 'none',
    });
    request = {
      clientId: client.clientId,
      redirectUri: 'http://127.0.0.1:4000/callback',
      codeChallenge: 'c'.repeat(43),
      state: 'st',
      resource: null,
      scope: MCP_SCOPES,
      expiresAt: EXPIRY,
    };
  });

  it('parks a request as pending under an oaa_ id', async () => {
    const created = await store.insertAuthorization(request);
    expect(created.id).toMatch(/^oaa_/);
    expect(created.status).toBe('pending');
    expect(created.redirectUri).toBe(request.redirectUri);
  });

  it('binds to the first reader and keeps returning it to them', async () => {
    const { id } = await store.insertAuthorization(request);
    expect(await store.bindAuthorization(id, ALICE, NOW)).not.toBeNull();
    expect(await store.bindAuthorization(id, ALICE, LATER)).not.toBeNull();
  });

  it('refuses a second person once bound', async () => {
    const { id } = await store.insertAuthorization(request);
    await store.bindAuthorization(id, ALICE, NOW);
    expect(await store.bindAuthorization(id, BOB, NOW)).toBeNull();
    expect(
      await store.decideAuthorization(id, BOB, 'approved', NOW)
    ).toBeNull();
  });

  it('refuses an expired or unknown request', async () => {
    const { id } = await store.insertAuthorization(request);
    expect(await store.bindAuthorization(id, ALICE, AFTER_EXPIRY)).toBeNull();
    expect(await store.bindAuthorization('oaa_unknown', ALICE, NOW)).toBeNull();
  });

  it('cannot be decided before someone opened it', async () => {
    const { id } = await store.insertAuthorization(request);
    expect(
      await store.decideAuthorization(id, ALICE, 'approved', NOW)
    ).toBeNull();
  });

  it('is decided exactly once', async () => {
    const { id } = await store.insertAuthorization(request);
    await store.bindAuthorization(id, ALICE, NOW);
    const decided = await store.decideAuthorization(id, ALICE, 'approved', NOW);
    expect(decided?.status).toBe('approved');
    expect(
      await store.decideAuthorization(id, ALICE, 'denied', LATER)
    ).toBeNull();
    // A decided request is no longer readable as pending either.
    expect(await store.bindAuthorization(id, ALICE, LATER)).toBeNull();
  });

  it('cannot be decided after it expired', async () => {
    const { id } = await store.insertAuthorization(request);
    await store.bindAuthorization(id, ALICE, NOW);
    expect(
      await store.decideAuthorization(id, ALICE, 'approved', AFTER_EXPIRY)
    ).toBeNull();
  });

  it('sweeps expired requests', async () => {
    const { id } = await store.insertAuthorization(request);
    await store.deleteExpiredAuthorizations(AFTER_EXPIRY);
    expect(await store.bindAuthorization(id, ALICE, NOW)).toBeNull();
  });
});

describe('stored consents', () => {
  it('records, finds and renews a consent per person and client', async () => {
    const store = new InMemoryOAuthStore();
    expect(await store.findConsent(ALICE, 'oac_x')).toBeNull();
    await store.upsertConsent(ALICE, 'oac_x', 'mcp:read');
    await store.upsertConsent(ALICE, 'oac_x', MCP_SCOPES);
    expect(await store.findConsent(ALICE, 'oac_x')).toEqual({
      scope: MCP_SCOPES,
    });
    expect(await store.findConsent(BOB, 'oac_x')).toBeNull();
    expect(await store.findConsent(ALICE, 'oac_y')).toBeNull();
  });
});
