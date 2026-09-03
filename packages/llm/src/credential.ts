import { inject } from '@workspace/di';

/**
 * Model vendors this server knows how to talk to — the single source of the
 * closed set. The database mirrors it in a check constraint, the credential
 * resolver validates a stored row against it, and the model factory has an
 * adapter for each. Adding a vendor means adding it here, to that constraint,
 * and to the factory — and nowhere else can widen it, which is what stops
 * "run on your own key" becoming "point the server at an arbitrary endpoint".
 */
export const PROVIDER_NAMES = [
  'anthropic',
  'openai',
  'xai',
  'deepseek',
  'moonshot',
  'ollama',
] as const;

export type ProviderName = (typeof PROVIDER_NAMES)[number];

export interface ResolvedCredential {
  readonly provider: ProviderName;
  readonly apiKey: string;
  /** Model the credential prefers; the caller's own default applies if absent. */
  readonly model?: string;
  /**
   * Endpoint override, for a provider whose location is not fixed — Ollama runs
   * wherever the user installed it. Ignored by the vendors whose endpoint is
   * their own; required by the ones that have none of their own.
   */
  readonly baseURL?: string;
  /**
   * Whose key this is. When the caller supplied it, the spend is billed to
   * them by their own provider — which is why no ceiling of ours applies to
   * it, and why this flag rather than the key itself is what the guard reads.
   */
  readonly ownedByCaller: boolean;
}

/**
 * Port: whose key a metered call should run on.
 *
 * Resolution is deliberately ordered the same way the budget's is — the
 * platform's own configuration is the fallback, and anything more specific
 * wins. A subject with no stored credential simply runs on the platform key,
 * which is how every deployment behaves today.
 */
export interface ICredentialResolver {
  /** `subjectId` is null for background work, which has no user to bill. */
  resolve(subjectId: string | null): Promise<ResolvedCredential>;
  /**
   * Whether this subject runs on a key of their own — the question a vitrine
   * asks. Separate from {@link resolve} on purpose: showing whether a ceiling
   * applies must not decrypt a secret to find out.
   */
  usesOwnCredential(subjectId: string | null): Promise<boolean>;
}

export const CREDENTIAL_RESOLVER = Symbol.for(
  'zero-memory:credential-resolver'
);

export const injectCredentialResolver = () => inject(CREDENTIAL_RESOLVER);

/**
 * The platform's own key, from the environment.
 *
 * Used when nobody supplied one of their own — and it is the only credential
 * background work ever runs on, since upkeep is done for no user in
 * particular.
 */
export class EnvCredentialResolver implements ICredentialResolver {
  constructor(private readonly env: NodeJS.ProcessEnv = process.env) {}

  /** The platform's key is by definition not the caller's own. */
  usesOwnCredential(): Promise<boolean> {
    return Promise.resolve(false);
  }

  resolve(): Promise<ResolvedCredential> {
    const apiKey = this.env['ANTHROPIC_API_KEY'];
    if (apiKey === undefined || apiKey.trim() === '') {
      throw new Error('ANTHROPIC_API_KEY is not set');
    }
    // Deliberately NO model here. A credential-carried model overrides the
    // model every call names (see effectiveModel), which is right for a
    // stored BYOK row — its owner chose it — but the platform credential
    // backs EVERY purpose at once: pinning ZM_EXTRACTOR_MODEL on it silently
    // downgraded the hygiene/portability/re-verification judges and the
    // web-search call to the extraction tier. The consumers that want that
    // env (extractor, ROI judge/prober) read it themselves and pass it as
    // the call's own model.
    return Promise.resolve({
      provider: 'anthropic',
      apiKey,
      ownedByCaller: false,
    });
  }
}
