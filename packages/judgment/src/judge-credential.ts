import { inject } from '@workspace/di';

import type { JudgeConfig } from './judge-config.js';
import type { JudgeProviderName } from './judgment.port.js';

export interface ResolvedJudgeCredential {
  readonly provider: JudgeProviderName;
  readonly apiKey: string;
  readonly model: string;
  /** True when the account supplied the key (BYOK): their spend, their egress choice. */
  readonly ownedByCaller: boolean;
}

/**
 * Port: whose judge key a call runs on. An account's own key wins; otherwise
 * the platform key of the provider the account chose (or the platform
 * default). Null means "no judge configured for this caller" — the feature
 * stays off for them. A configured provider that fails is NOT replaced by
 * another one: that would be a fallback, and the project forbids fallbacks.
 */
export interface IJudgeCredentialResolver {
  /**
   * `preferred` may still be on its way (the account's settings, read in
   * parallel): a resolver looks up the account's own key meanwhile and waits
   * for the preference only when it falls back to a platform key.
   */
  resolve(
    subjectId: string | null,
    preferred?: JudgeProviderName | Promise<JudgeProviderName | undefined>
  ): Promise<ResolvedJudgeCredential | null>;
}

export const JUDGE_CREDENTIAL_RESOLVER = Symbol.for(
  'zero-memory:judge-credential-resolver'
);
export const injectJudgeCredentialResolver = () =>
  inject(JUDGE_CREDENTIAL_RESOLVER);

/** Platform keys only, from the server env. The database-backed resolver wraps this. */
export class EnvJudgeCredentialResolver implements IJudgeCredentialResolver {
  constructor(private readonly config: JudgeConfig) {}

  async resolve(
    _subjectId: string | null,
    preferred?: JudgeProviderName | Promise<JudgeProviderName | undefined>
  ): Promise<ResolvedJudgeCredential | null> {
    const provider = (await preferred) ?? this.config.provider;
    const apiKey = this.config.platformKeys[provider];
    if (!apiKey) return null;
    return {
      provider,
      apiKey,
      model: this.config.models[provider],
      ownedByCaller: false,
    };
  }
}
