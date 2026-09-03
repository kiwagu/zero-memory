import { singleton } from '@workspace/di';
import {
  EnvCredentialResolver,
  type ICredentialResolver,
  PROVIDER_NAMES,
  type ProviderName,
  type ResolvedCredential,
} from '@workspace/llm';
import { createLogger } from '@workspace/logger';

import { createServiceRoleClient, type Client } from '../supabase.client.js';

const logger = createLogger('credential-resolver');

/**
 * Resolves whose key a call runs on: the caller's own if they stored one,
 * otherwise the platform's.
 *
 * Reads through `public.provider_credential_for`, the single definer function
 * that can decrypt a stored key — PostgREST exposes only the `public` schema,
 * so the vault is unreachable from here by any other route, and that function
 * is granted to the service role alone.
 *
 * The resolved key is passed straight to a provider adapter and never stored,
 * logged, or returned upward: nothing in this class puts `apiKey` anywhere
 * except the object it returns.
 */
@singleton()
export class SupabaseCredentialResolver implements ICredentialResolver {
  readonly #platform = new EnvCredentialResolver();

  #client: Client | null = null;

  async resolve(subjectId: string | null): Promise<ResolvedCredential> {
    // Background upkeep runs for no one in particular, so there is no user
    // whose key it could run on — it is always the platform's own work.
    if (subjectId === null) {
      return this.#platform.resolve();
    }

    let data: unknown;
    try {
      const result = await this.#serviceClient().rpc(
        'provider_credential_for',
        {
          p_subject_id: subjectId,
        }
      );
      if (result.error) throw new Error(result.error.message);
      data = result.data;
    } catch (error: unknown) {
      // Falling back to the platform key rather than failing: a lookup that
      // cannot complete must not stop generation for someone who may not even
      // have stored a key. The message is logged without the row, so nothing
      // about the credential can reach the log.
      logger.warn(
        'could not read a stored credential; using the platform key',
        {
          error: error instanceof Error ? error.message : String(error),
        }
      );
      return this.#platform.resolve();
    }

    const row = Array.isArray(data) ? data[0] : data;
    if (!isCredentialRow(row)) {
      return this.#platform.resolve();
    }

    return {
      provider: row.provider,
      apiKey: row.api_key,
      ...(row.model === null ? {} : { model: row.model }),
      ...(row.base_url === null ? {} : { baseURL: row.base_url }),
      ownedByCaller: true,
    };
  }

  /**
   * Reads only whether a row exists — no vault join, so no decryption. The
   * vitrine asks this on every receipt, and decrypting a key to render a tile
   * would be exposure bought for nothing.
   */
  async usesOwnCredential(subjectId: string | null): Promise<boolean> {
    if (subjectId === null) return false;
    const { data, error } = await this.#serviceClient()
      .from('provider_credentials')
      .select('subject_id')
      .eq('subject_id', subjectId)
      .maybeSingle();
    // Unreadable means unknown, and unknown must not hide a ceiling that does
    // apply — so the safe answer is "not their own key".
    if (error) return false;
    return data !== null;
  }

  #serviceClient(): Client {
    this.#client ??= createServiceRoleClient();
    return this.#client;
  }
}

interface CredentialRow {
  provider: ProviderName;
  model: string | null;
  api_key: string;
  base_url: string | null;
}

/**
 * A row is only usable if it names a provider this server has an adapter for.
 * The database constrains that too; checking again here means an unexpected
 * value falls back to the platform key instead of reaching a lookup that
 * would throw on an unknown vendor. Validated against the one closed set so a
 * new vendor is added in a single place.
 */
const isCredentialRow = (value: unknown): value is CredentialRow => {
  if (typeof value !== 'object' || value === null) return false;
  const row = value as Record<string, unknown>;
  return (
    (PROVIDER_NAMES as readonly string[]).includes(row['provider'] as string) &&
    typeof row['api_key'] === 'string' &&
    row['api_key'] !== '' &&
    (row['model'] === null || typeof row['model'] === 'string') &&
    (row['base_url'] === null || typeof row['base_url'] === 'string')
  );
};
