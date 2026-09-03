import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import type {
  OAuthClientInformationFull,
  OAuthClientMetadata,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';

import { OAuthStateStore } from './state-store.js';

export interface FileOAuthProviderOptions {
  /** The MCP server URL (the `/mcp` endpoint); also the state-store key. */
  serverUrl: string;
  /** Loopback redirect, set only during the interactive login. */
  redirectUri?: string;
  /** Persistence backend (defaults to the shared XDG state file). */
  store?: OAuthStateStore;
  /**
   * Called when authorization is required. Provided ONLY by the login flow
   * (prints/opens the URL). When absent — i.e. runtime, non-interactive use —
   * needing to authorize is a hard error, not a browser pop.
   */
  onAuthorizationRequired?: (authorizationUrl: URL) => void | Promise<void>;
}

/**
 * File-backed {@link OAuthClientProvider} for headless clients (watcher, hooks)
 * and the one-time login bootstrap. The SDK transport drives it: it reuses the
 * stored access token, refreshes with the refresh token when expired, and only
 * falls back to `redirectToAuthorization` when neither works.
 */
export class FileOAuthProvider implements OAuthClientProvider {
  readonly #store: OAuthStateStore;
  readonly #options: FileOAuthProviderOptions;

  constructor(options: FileOAuthProviderOptions) {
    this.#options = options;
    this.#store = options.store ?? new OAuthStateStore();
  }

  get #key(): string {
    return this.#options.serverUrl;
  }

  get redirectUrl(): string {
    return (
      this.#options.redirectUri ??
      this.#store.entry(this.#key)?.redirectUri ??
      ''
    );
  }

  get clientMetadata(): OAuthClientMetadata {
    const redirectUrl = this.redirectUrl;
    if (redirectUrl === '') {
      // Runtime with no login on record: registering with an empty redirect
      // URI would only produce a cryptic invalid_client_metadata error.
      throw this.#notAuthenticatedError();
    }
    return {
      client_name: 'zero-memory client',
      redirect_uris: [redirectUrl],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      scope: 'mcp:read mcp:write',
    };
  }

  clientInformation(): OAuthClientInformationFull | undefined {
    return this.#store.entry(this.#key)?.clientInformation;
  }

  saveClientInformation(clientInformation: OAuthClientInformationFull): void {
    this.#save({ clientInformation });
  }

  tokens(): OAuthTokens | undefined {
    return this.#store.entry(this.#key)?.tokens;
  }

  saveTokens(tokens: OAuthTokens): void {
    this.#save({ tokens });
  }

  saveCodeVerifier(codeVerifier: string): void {
    this.#save({ codeVerifier });
  }

  codeVerifier(): string {
    const verifier = this.#store.entry(this.#key)?.codeVerifier;
    if (!verifier) {
      throw new Error('No PKCE code verifier stored — re-run the login flow.');
    }
    return verifier;
  }

  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    if (this.#options.onAuthorizationRequired) {
      await this.#options.onAuthorizationRequired(authorizationUrl);
      return;
    }
    throw this.#notAuthenticatedError();
  }

  /**
   * Called by the SDK's `auth()` after a recoverable OAuth error (e.g. the
   * server rejected our refresh token) so the retry starts from a clean slate
   * instead of replaying the same dead credentials forever.
   */
  invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier'): void {
    const fields: Record<
      Exclude<typeof scope, 'all'>,
      Array<'clientInformation' | 'tokens' | 'codeVerifier'>
    > = {
      client: ['clientInformation'],
      tokens: ['tokens'],
      verifier: ['codeVerifier'],
    };
    this.#store.remove(this.#key, scope === 'all' ? 'all' : fields[scope]);
  }

  #notAuthenticatedError(): Error {
    return new Error(
      `Not authenticated with ${this.#key}. Run the login command ` +
        '("zero-memory-watcher login") to authorize this machine.'
    );
  }

  /** Persist a patch, capturing the login-time redirect so runtime can reuse it. */
  #save(patch: Parameters<OAuthStateStore['update']>[1]): void {
    const base = this.#options.redirectUri
      ? { redirectUri: this.#options.redirectUri }
      : {};
    this.#store.update(this.#key, { ...base, ...patch });
  }
}
