import { Elysia } from 'elysia';

import type { IAuthGateway } from './auth-gateway.js';
import {
  handleAuthorizationRead,
  handleAuthorizeStart,
  handleConsentDecision,
  handleRegister,
  handleToken,
  type OAuthDeps,
} from './handlers.js';
import {
  authorizationServerMetadata,
  protectedResourceMetadata,
} from './metadata.js';
import type { IOAuthStore } from './oauth-store.js';
import {
  FixedWindowRateLimiter,
  rateLimitedResponse,
  rateLimiterOptionsFromEnv,
  resolveClientIp,
  type IRateLimiter,
  type RateLimiterOptions,
  type RequestIpSource,
} from './rate-limit.js';
import { SupabaseAuthGateway } from './supabase/supabase-auth-gateway.js';
import { SupabaseOAuthStore } from './supabase/supabase-oauth-store.js';

export interface McpAuthPluginOptions {
  /** Public base URL of this server (OAuth issuer), no trailing slash. */
  issuer: string;
  /**
   * External origin of the dashboard, no trailing slash. The authorization
   * endpoint sends the person there to sign in and approve the client.
   */
  webUrl: string;
  /** Storage override (defaults to the Supabase service-role adapter). */
  store?: IOAuthStore;
  /** Identity gateway override (defaults to Supabase Auth). */
  auth?: IAuthGateway;
  /** Authorization code TTL in milliseconds (default 5 minutes). */
  codeTtlMs?: number;
  /** Rate-limiter override (defaults read ZM_RATELIMIT_MAX / _WINDOW_S). */
  rateLimit?: RateLimiterOptions;
  /**
   * The count shared by every instance of a server that runs as several.
   * Without it each process keeps its own count, configured by `rateLimit`.
   */
  limiter?: IRateLimiter;
  /**
   * Where the client's socket address comes from. Elysia hands a route the
   * server of its own app, which is null when this plugin's app does not
   * listen itself but is reached through a forwarding app; that app's server
   * is the one that knows the socket. Without it every caller would share one
   * rate-limit bucket.
   */
  requestIp?: () => RequestIpSource | null | undefined;
}

/** A count kept in this process, swept as its windows elapse. */
const inProcessLimiter = (overrides?: RateLimiterOptions): IRateLimiter => {
  const limiterOptions = { ...rateLimiterOptionsFromEnv(), ...overrides };
  const limiter = new FixedWindowRateLimiter(limiterOptions);
  const sweeper = setInterval(
    () => limiter.sweep(),
    limiterOptions.windowSeconds * 1000
  );
  sweeper.unref?.();
  return limiter;
};

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    },
  });

const escapeHtml = (value: string): string =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');

/**
 * The one page this server still renders: why an authorization request was
 * refused before anyone could be sent anywhere. Never cached, never framed.
 */
const errorPage = (message: string, status: number): Response =>
  new Response(`<!doctype html><p>${escapeHtml(message)}</p>`, {
    status,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      'content-security-policy': "frame-ancestors 'none'",
    },
  });

/**
 * Embedded OAuth 2.1 authorization server (MCP auth spec): RFC 8414/9728
 * metadata, RFC 7591 dynamic client registration, /oauth/authorize with
 * mandatory PKCE S256 that hands the person to the dashboard to sign in and
 * approve the client, the two endpoints that consent page talks to, and
 * /oauth/token returning the agent's own Supabase session pair.
 */
export const mcpAuthPlugin = (options: McpAuthPluginOptions) => {
  const deps: OAuthDeps = {
    store: options.store ?? new SupabaseOAuthStore(),
    auth: options.auth ?? new SupabaseAuthGateway(),
    issuer: options.issuer.replace(/\/$/, ''),
    webUrl: options.webUrl.replace(/\/$/, ''),
    codeTtlMs: options.codeTtlMs,
  };

  // Guard on the unauthenticated endpoints: token (code / refresh-token
  // guessing), authorize (each request parks a pending row before anyone has
  // signed in), register (DCR spam). Keys are per client IP per route.
  const limiter = options.limiter ?? inProcessLimiter(options.rateLimit);

  const overLimit = async (
    route: 'token' | 'authorize' | 'register',
    request: Request,
    server: RequestIpSource | null
  ): Promise<Response | null> => {
    const decision = await limiter.hit(
      `${resolveClientIp(request, options.requestIp?.() ?? server)}:${route}`
    );
    return decision.allowed
      ? null
      : rateLimitedResponse(decision.retryAfterSeconds);
  };

  return (
    new Elysia({ name: 'mcp-auth' })
      .get('/.well-known/oauth-authorization-server', () =>
        json(authorizationServerMetadata(deps.issuer))
      )
      .get('/.well-known/oauth-protected-resource', () =>
        json(protectedResourceMetadata(deps.issuer))
      )
      .get('/.well-known/oauth-protected-resource/mcp', () =>
        json(protectedResourceMetadata(deps.issuer))
      )
      .post('/oauth/register', async ({ body, request, server }) => {
        const limited = await overLimit('register', request, server);
        if (limited) {
          return limited;
        }
        const result = await handleRegister(deps, body);
        return json(result.body, result.status);
      })
      .get('/oauth/authorize', async ({ query, request, server }) => {
        const limited = await overLimit('authorize', request, server);
        if (limited) {
          return limited;
        }
        const result = await handleAuthorizeStart(deps, query);
        if (result.kind === 'invalid') {
          return errorPage(result.message, result.status);
        }
        return new Response(null, {
          status: 302,
          headers: { location: result.location, 'cache-control': 'no-store' },
        });
      })
      // The dashboard's consent page calls these with the person's own session
      // as the bearer; they are not part of the OAuth protocol surface.
      .get('/oauth/authorizations/:id', async ({ params, query, request }) => {
        const result = await handleAuthorizationRead(deps, {
          authorizationId: params.id,
          authorization: request.headers.get('authorization'),
          // The dashboard sets it from how the browser arrived; see the input's
          // doc. Anything but the one value reads as "show the screen".
          screenless: query.screenless === '1',
        });
        return json(result.body, result.status);
      })
      .post(
        '/oauth/authorizations/:id/consent',
        async ({ params, request, body }) => {
          const result = await handleConsentDecision(deps, {
            authorizationId: params.id,
            authorization: request.headers.get('authorization'),
            body,
          });
          return json(result.body, result.status);
        }
      )
      .post('/oauth/token', async ({ body, request, server }) => {
        const limited = await overLimit('token', request, server);
        if (limited) {
          return limited;
        }
        const result = await handleToken(deps, body);
        return json(result.body, result.status);
      })
  );
};
