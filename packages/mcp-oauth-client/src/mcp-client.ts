import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import { FileOAuthProvider } from './file-oauth-provider.js';
import { OAuthStateStore } from './state-store.js';

/**
 * How long closing waits for the server to confirm the session ended. A server
 * that does not answer in time keeps the session until it idles out, as every
 * session did before; the caller is never held longer than this.
 */
const SESSION_END_TIMEOUT_MS = 1_000;

/**
 * The SDK transport's `close()` only closes this side: it aborts the local
 * connection and leaves the server's session open until it idles out. The
 * hooks open a session per run, and the server caps how many sessions one
 * account holds, evicting the least recently used — so those leftovers push
 * out the long-lived session of the person's editor. This transport ends its
 * server session (the protocol's DELETE) before it closes.
 */
class SessionEndingTransport extends StreamableHTTPClientTransport {
  override async close(): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      this.terminateSession().catch(() => undefined),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, SESSION_END_TIMEOUT_MS);
      }),
    ]);
    clearTimeout(timer);
    await super.close();
  }
}

/**
 * Builds a streamable-HTTP transport wired to the file-backed OAuth provider.
 * The SDK attaches the stored access token, refreshes it on expiry, and throws
 * `UnauthorizedError` from `connect` when the machine has not run login yet —
 * callers decide whether that is fatal (watcher: log) or silent (hooks).
 * Closing it ends the session on the server.
 */
export const createAuthedTransport = (
  serverUrl: string,
  store: OAuthStateStore = new OAuthStateStore()
): StreamableHTTPClientTransport => {
  // Tag requests with the client's version (set by the watcher at startup) so
  // the server can log which plugin/watcher version each request came from.
  const version = process.env.ZM_CLIENT_VERSION;
  return new SessionEndingTransport(new URL(serverUrl), {
    authProvider: new FileOAuthProvider({ serverUrl, store }),
    ...(version
      ? { requestInit: { headers: { 'x-zm-client-version': version } } }
      : {}),
  });
};
