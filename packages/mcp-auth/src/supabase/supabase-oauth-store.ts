import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@workspace/db';

import type {
  IOAuthStore,
  OAuthClientRecord,
  OAuthCodeRecord,
} from '../oauth-store.js';

type ClientRow = Database['public']['Tables']['oauth_clients']['Row'];
type CodeRow = Database['public']['Tables']['oauth_codes']['Row'];

/** Fail fast on missing configuration — no silent fallbacks. */
const resolveServiceEnv = (): { url: string; serviceRoleKey: string } => {
  const url = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceRoleKey) {
    throw new Error(
      'SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in the ' +
        'environment.'
    );
  }
  return { url, serviceRoleKey };
};

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

  #client(): SupabaseClient<Database> {
    const { url, serviceRoleKey } = resolveServiceEnv();
    return createClient<Database>(url, serviceRoleKey, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false,
      },
    });
  }
}
