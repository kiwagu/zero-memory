import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@workspace/db';

import type {
  IOAuthStore,
  NewOAuthAuthorization,
  OAuthAuthorizationRecord,
  OAuthAuthorizationStatus,
  OAuthClientRecord,
  OAuthCodeRecord,
  OAuthConsentRecord,
} from '../oauth-store.js';
import { ONE_SHOT_AUTH, resolveServiceEnv } from './supabase-env.js';

type ClientRow = Database['public']['Tables']['oauth_clients']['Row'];
type CodeRow = Database['public']['Tables']['oauth_codes']['Row'];
type AuthorizationRow =
  Database['public']['Tables']['oauth_authorizations']['Row'];

const toClientRecord = (row: ClientRow): OAuthClientRecord => ({
  clientId: row.client_id,
  clientName: row.client_name,
  redirectUris: row.redirect_uris,
  tokenEndpointAuthMethod: row.token_endpoint_auth_method,
});

const toCodeRecord = (row: CodeRow): OAuthCodeRecord => ({
  code: row.code,
  clientId: row.client_id,
  userId: row.user_id,
  codeChallenge: row.code_challenge,
  redirectUri: row.redirect_uri,
  resource: row.resource,
  accessToken: row.access_token,
  refreshToken: row.refresh_token,
  expiresAt: new Date(row.expires_at),
});

const AUTHORIZATION_STATUSES: readonly OAuthAuthorizationStatus[] = [
  'pending',
  'approved',
  'denied',
];

const toAuthorizationStatus = (value: string): OAuthAuthorizationStatus => {
  const status = AUTHORIZATION_STATUSES.find((s) => s === value);
  if (!status) {
    throw new Error(`Unknown OAuth authorization status: ${value}`);
  }
  return status;
};

const toAuthorizationRecord = (
  row: AuthorizationRow
): OAuthAuthorizationRecord => ({
  id: row.id,
  clientId: row.client_id,
  redirectUri: row.redirect_uri,
  codeChallenge: row.code_challenge,
  state: row.state,
  resource: row.resource,
  scope: row.scope,
  status: toAuthorizationStatus(row.status),
  expiresAt: new Date(row.expires_at),
});

/**
 * Service-role adapter for the OAuth store: `oauth_clients` / `oauth_codes`
 * are deny-all under RLS, so only this adapter (used exclusively by the
 * OAuth endpoints) can reach them.
 */
export class SupabaseOAuthStore implements IOAuthStore {
  async insertClient(
    client: Omit<OAuthClientRecord, 'clientId'>
  ): Promise<OAuthClientRecord> {
    const { data, error } = await this.#client()
      .from('oauth_clients')
      .insert({
        client_name: client.clientName,
        redirect_uris: client.redirectUris,
        token_endpoint_auth_method: client.tokenEndpointAuthMethod,
      })
      .select()
      .single();
    if (error) {
      throw new Error(`Failed to register OAuth client: ${error.message}`);
    }
    return toClientRecord(data);
  }

  async findClient(clientId: string): Promise<OAuthClientRecord | null> {
    const { data, error } = await this.#client()
      .from('oauth_clients')
      .select()
      .eq('client_id', clientId)
      .maybeSingle();
    if (error) {
      throw new Error(`Failed to load OAuth client: ${error.message}`);
    }
    return data ? toClientRecord(data) : null;
  }

  async insertCode(record: OAuthCodeRecord): Promise<void> {
    // oauth_codes.user_id is our domain usr_ id (references profiles). The
    // authorize flow carries the auth uuid, so map it through profiles here.
    const userEntityId = await this.#resolveUserEntityId(record.userId);
    const { error } = await this.#client().from('oauth_codes').insert({
      code: record.code,
      client_id: record.clientId,
      user_id: userEntityId,
      code_challenge: record.codeChallenge,
      redirect_uri: record.redirectUri,
      resource: record.resource,
      access_token: record.accessToken,
      refresh_token: record.refreshToken,
      expires_at: record.expiresAt.toISOString(),
    });
    if (error) {
      throw new Error(`Failed to store authorization code: ${error.message}`);
    }
  }

  /** Maps an auth uuid to its domain usr_ id (profiles.id), service-role. */
  async #resolveUserEntityId(authUserId: string): Promise<string> {
    const { data, error } = await this.#client()
      .from('profiles')
      .select('id')
      .eq('user_id', authUserId)
      .maybeSingle();
    if (error) {
      throw new Error(`Failed to resolve profile: ${error.message}`);
    }
    if (!data) {
      throw new Error(`No profile row for auth user ${authUserId}.`);
    }
    return data.id;
  }

  async consumeCode(code: string): Promise<OAuthCodeRecord | null> {
    // Atomic single-use: DELETE ... RETURNING claims the row exactly once
    // even under concurrent redemption attempts.
    const { data, error } = await this.#client()
      .from('oauth_codes')
      .delete()
      .eq('code', code)
      .is('used_at', null)
      .gt('expires_at', new Date().toISOString())
      .select()
      .maybeSingle();
    if (error) {
      throw new Error(`Failed to consume authorization code: ${error.message}`);
    }
    return data ? toCodeRecord(data) : null;
  }

  async deleteExpiredCodes(now: Date): Promise<void> {
    const { error } = await this.#client()
      .from('oauth_codes')
      .delete()
      .lte('expires_at', now.toISOString());
    if (error) {
      throw new Error(`Failed to clean expired codes: ${error.message}`);
    }
  }

  async insertAuthorization(
    authorization: NewOAuthAuthorization
  ): Promise<OAuthAuthorizationRecord> {
    const { data, error } = await this.#client()
      .from('oauth_authorizations')
      .insert({
        client_id: authorization.clientId,
        redirect_uri: authorization.redirectUri,
        code_challenge: authorization.codeChallenge,
        state: authorization.state,
        resource: authorization.resource,
        scope: authorization.scope,
        expires_at: authorization.expiresAt.toISOString(),
      })
      .select()
      .single();
    if (error) {
      throw new Error(`Failed to store authorization: ${error.message}`);
    }
    return toAuthorizationRecord(data);
  }

  async bindAuthorization(
    id: string,
    authUserId: string,
    now: Date
  ): Promise<OAuthAuthorizationRecord | null> {
    const userEntityId = await this.#resolveUserEntityId(authUserId);
    const nowIso = now.toISOString();
    // First reader wins: the update only matches while nobody holds the row,
    // so of two concurrent first readers exactly one gets it back.
    const { data: claimed, error: claimError } = await this.#client()
      .from('oauth_authorizations')
      .update({ user_id: userEntityId })
      .eq('id', id)
      .is('user_id', null)
      .eq('status', 'pending')
      .gt('expires_at', nowIso)
      .select()
      .maybeSingle();
    if (claimError) {
      throw new Error(`Failed to bind authorization: ${claimError.message}`);
    }
    if (claimed) {
      return toAuthorizationRecord(claimed);
    }
    // Already held: it is still theirs to read, and nobody else's.
    const { data: held, error: readError } = await this.#client()
      .from('oauth_authorizations')
      .select()
      .eq('id', id)
      .eq('user_id', userEntityId)
      .eq('status', 'pending')
      .gt('expires_at', nowIso)
      .maybeSingle();
    if (readError) {
      throw new Error(`Failed to read authorization: ${readError.message}`);
    }
    return held ? toAuthorizationRecord(held) : null;
  }

  async decideAuthorization(
    id: string,
    authUserId: string,
    status: Exclude<OAuthAuthorizationStatus, 'pending'>,
    now: Date
  ): Promise<OAuthAuthorizationRecord | null> {
    const userEntityId = await this.#resolveUserEntityId(authUserId);
    // One conditional update: the decision is taken exactly once, only by the
    // person the request is bound to, and never after it expired.
    const { data, error } = await this.#client()
      .from('oauth_authorizations')
      .update({ status, decided_at: now.toISOString() })
      .eq('id', id)
      .eq('user_id', userEntityId)
      .eq('status', 'pending')
      .gt('expires_at', now.toISOString())
      .select()
      .maybeSingle();
    if (error) {
      throw new Error(`Failed to decide authorization: ${error.message}`);
    }
    return data ? toAuthorizationRecord(data) : null;
  }

  async deleteExpiredAuthorizations(now: Date): Promise<void> {
    const { error } = await this.#client()
      .from('oauth_authorizations')
      .delete()
      .lte('expires_at', now.toISOString());
    if (error) {
      throw new Error(
        `Failed to clean expired authorizations: ${error.message}`
      );
    }
  }

  async findConsent(
    authUserId: string,
    clientId: string
  ): Promise<OAuthConsentRecord | null> {
    const userEntityId = await this.#resolveUserEntityId(authUserId);
    const { data, error } = await this.#client()
      .from('oauth_consents')
      .select('scope, redirect_uri')
      .eq('user_id', userEntityId)
      .eq('client_id', clientId)
      .is('revoked_at', null)
      .maybeSingle();
    if (error) {
      throw new Error(`Failed to load consent: ${error.message}`);
    }
    return data
      ? { scope: data.scope, redirectUri: data.redirect_uri ?? null }
      : null;
  }

  async upsertConsent(
    authUserId: string,
    clientId: string,
    scope: string,
    redirectUri: string
  ): Promise<void> {
    const userEntityId = await this.#resolveUserEntityId(authUserId);
    const { error } = await this.#client().from('oauth_consents').upsert(
      {
        user_id: userEntityId,
        client_id: clientId,
        scope,
        redirect_uri: redirectUri,
        granted_at: new Date().toISOString(),
        revoked_at: null,
      },
      { onConflict: 'user_id,client_id' }
    );
    if (error) {
      throw new Error(`Failed to store consent: ${error.message}`);
    }
  }

  #client(): SupabaseClient<Database> {
    const { url, serviceRoleKey } = resolveServiceEnv();
    return createClient<Database>(url, serviceRoleKey, {
      auth: ONE_SHOT_AUTH,
    });
  }
}
