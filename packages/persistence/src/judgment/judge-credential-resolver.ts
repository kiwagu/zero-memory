import {
  JudgeCredentialUnavailableError,
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
 * caller prefers. Only a lookup that succeeded and found no key falls back to
 * the platform key; a failed lookup or an unreadable row throws
 * `JudgeCredentialUnavailableError`.
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
    preferred?: JudgeProviderName
  ): Promise<ResolvedJudgeCredential | null> {
    const choice = isProvider(preferred) ? preferred : undefined;
    if (subjectId === null) return this.platform.resolve(null, choice);
    let data: unknown;
    try {
      const result = await this.#serviceClient().rpc('judge_credential_for', {
        p_subject_id: subjectId,
      });
      if (result.error) throw new Error(result.error.message);
      data = result.data;
    } catch (error: unknown) {
      // Not knowing is not having none: falling back here could judge on the
      // instance's key, and with another provider, for an account that holds
      // its own. The message only, never the row.
      const message = error instanceof Error ? error.message : String(error);
      logger.warn('could not read a stored judge credential', {
        error: message,
      });
      throw new JudgeCredentialUnavailableError(
        `judge credential lookup failed: ${message}`
      );
    }
    const row: unknown = Array.isArray(data) ? data[0] : data;
    // Only an established absence reaches the platform key.
    if (row === undefined || row === null) {
      return this.platform.resolve(subjectId, choice);
    }
    if (!isRow(row)) {
      logger.warn('a stored judge credential has an unexpected shape');
      throw new JudgeCredentialUnavailableError(
        'judge credential lookup returned an unexpected row'
      );
    }
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
