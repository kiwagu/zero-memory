import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import { FileOAuthProvider } from './file-oauth-provider.js';
import { OAuthStateStore } from './state-store.js';

/**
 * Builds a streamable-HTTP transport wired to the file-backed OAuth provider.
 * The SDK attaches the stored access token, refreshes it on expiry, and throws
 * `UnauthorizedError` from `connect` when the machine has not run login yet —
 * callers decide whether that is fatal (watcher: log) or silent (hooks).
 */
export const createAuthedTransport = (
  serverUrl: string,
  store: OAuthStateStore = new OAuthStateStore()
): StreamableHTTPClientTransport => {
  // Tag requests with the client's version (set by the watcher at startup) so
  // the server can log which plugin/watcher version each request came from.
  const version = process.env.ZM_CLIENT_VERSION;
  return new StreamableHTTPClientTransport(new URL(serverUrl), {
    authProvider: new FileOAuthProvider({ serverUrl, store }),
    ...(version
      ? { requestInit: { headers: { 'x-zm-client-version': version } } }
      : {}),
  });
};
