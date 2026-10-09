import { getRequestId } from '@workspace/context';
import { createLogger, setLogContextResolver } from '@workspace/logger';
import {
  trustProxyFromEnv,
  type McpAuthPluginOptions,
} from '@workspace/mcp-auth';

import { createApp } from './app.js';
import type { IMcpSessionStore } from './mcp-session.store.js';
import { withRequestObservability } from './observability.js';
import { resolvePublicUrl, resolveWebUrl } from './public-url.js';
import { register } from './registry/index.js';

export interface HttpHandlerOptions {
  /** The port this server listens on; the public URL defaults from it. */
  port: number;
  /** Where MCP sessions live between requests. */
  sessions: IMcpSessionStore;
  /** Answer MCP POSTs with one JSON body instead of an SSE stream. */
  jsonResponse?: boolean;
  /** Where the OAuth rate limiter learns the client's address. */
  requestIp?: McpAuthPluginOptions['requestIp'];
}

export interface HttpHandler {
  handle: (request: Request) => Promise<Response>;
  publicUrl: string;
  webUrl: string;
}

/**
 * The whole server as one request handler: the DI container registered, the
 * routes composed, every request wrapped in its correlation context. What
 * differs between runtimes — how requests arrive, where sessions live — is
 * passed in, so a listening process and a function invoked per request run
 * the same code.
 */
export const createHttpHandler = (options: HttpHandlerOptions): HttpHandler => {
  const logger = createLogger('server');
  // The issuer is validated before anything listens: a wrong public URL breaks
  // every client at once and does it silently, so it is worth failing to start.
  const { url: publicUrl, warnings: publicUrlWarnings } = resolvePublicUrl({
    raw: process.env.ZM_PUBLIC_URL,
    port: options.port,
    trustProxy: trustProxyFromEnv(),
  });
  // The dashboard is where a person signs in and approves an agent; the
  // authorization endpoint sends them there, so it is validated the same way.
  const { url: webUrl, warnings: webUrlWarnings } = resolveWebUrl({
    raw: process.env.ZM_WEB_URL,
    trustProxy: trustProxyFromEnv(),
  });
  for (const warning of publicUrlWarnings) {
    logger.warn('public url', { warning });
  }
  for (const warning of webUrlWarnings) {
    logger.warn('web url', { warning });
  }

  // The logger is a dependency-free leaf: feed it the ambient correlation id so
  // every line — including deep persistence/extraction logs — carries requestId.
  setLogContextResolver(() => {
    const requestId = getRequestId();
    return requestId ? { requestId } : undefined;
  });

  register();

  const inner = createApp({
    publicUrl,
    webUrl,
    requestIp: options.requestIp,
    sessions: options.sessions,
    jsonResponse: options.jsonResponse,
  });
  const handle = withRequestObservability(
    (request) => inner.handle(request),
    logger
  );
  return { handle, publicUrl, webUrl };
};
