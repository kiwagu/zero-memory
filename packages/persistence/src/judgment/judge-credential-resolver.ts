import {
  JUDGE_PROVIDER_NAMES,
  type IJudgeCredentialResolver,
  type JudgeProviderName,
  type ResolvedJudgeCredential,
} from '@workspace/judgment';
import { createLogger } from '@workspace/logger';

import { createServiceRoleClient, type Client } from '../supabase.client.js';

const logger = createLogger('judge-credential-resolver');

interface JudgeCredentialRow {
  provider: JudgeProviderName;
  model: string | null;
  api_key: string;
}

const isProvider = (value: unknown): value is JudgeProviderName =>
  (JUDGE_PROVIDER_NAMES as readonly unknown[]).includes(value);

const isRow = (value: unknown): value is JudgeCredentialRow =>
  typeof value === 'object' &&
  value !== null &&
  isProvider((value as JudgeCredentialRow).provider) &&
  typeof (value as JudgeCredentialRow).api_key === 'string';

/**
 * Whose decision-model key a call runs on: the account's own (Vault, via the
 * server-only RPC) when installed, else the platform key of the provider the
 * caller prefers. Mirrors SupabaseCredentialResolver for the LLM key.
 *
 * A preferred provider outside the closed set counts as no preference, so a
 * stray value reaches the platform default instead of a lookup by an
 * arbitrary key. The resolved key goes only into the returned object: it is
 * never logged.
 */
export class SupabaseJudgeCredentialResolver implements IJudgeCredentialResolver {
  #client: Client | null = null;

  constructor(
    private readonly platform: IJudgeCredentialResolver,
    private readonly clientFactory: () => Client = createServiceRoleClient,
    private readonly defaultModels: Record<JudgeProviderName, string>
  ) {}

  async resolve(
    subjectId: string | null,
    preferred?: JudgeProviderName | Promise<JudgeProviderName | undefined>
  ): Promise<ResolvedJudgeCredential | null> {
    // Awaited only on the way to a platform key, so a preference still being
    // read never holds up the lookup of the account's own key.
    const choice = async (): Promise<JudgeProviderName | undefined> => {
      const value = await preferred;
      return isProvider(value) ? value : undefined;
    };
    if (subjectId === null) return this.platform.resolve(null, choice());
    let data: unknown;
    try {
      const result = await this.#serviceClient().rpc('judge_credential_for', {
        p_subject_id: subjectId,
      });
      if (result.error) throw new Error(result.error.message);
      data = result.data;
    } catch (error: unknown) {
      logger.warn(
        'could not read a stored judge credential; using the platform key',
        { error: error instanceof Error ? error.message : String(error) }
      );
      return this.platform.resolve(subjectId, choice());
    }
    const row: unknown = Array.isArray(data) ? data[0] : data;
    if (!isRow(row)) return this.platform.resolve(subjectId, choice());
    return {
      provider: row.provider,
      apiKey: row.api_key,
      model: row.model ?? this.defaultModels[row.provider],
      ownedByCaller: true,
    };
  }

  #serviceClient(): Client {
    this.#client ??= this.clientFactory();
    return this.#client;
  }
}
