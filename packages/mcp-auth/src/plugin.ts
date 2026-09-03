import { Elysia } from 'elysia';

import type { IAuthGateway } from './auth-gateway.js';
import {
  handleAuthorizeSubmit,
  handleRegister,
  handleToken,
  validateAuthorizeRequest,
  type OAuthDeps,
} from './handlers.js';
import { escapeHtml, renderLoginPage } from './login-page.js';
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
  type RateLimiterOptions,
  type RequestIpSource,
} from './rate-limit.js';
import { SupabaseAuthGateway } from './supabase/supabase-auth-gateway.js';
import { SupabaseOAuthStore } from './supabase/supabase-oauth-store.js';

export interface McpAuthPluginOptions {
  /** Public base URL of this server (OAuth issuer), no trailing slash. */
  issuer: string;
  /** Storage override (defaults to the Supabase service-role adapter). */
  store?: IOAuthStore;
  /** Identity gateway override (defaults to Supabase Auth). */
  auth?: IAuthGateway;
  /** Authorization code TTL in milliseconds (default 5 minutes). */
  codeTtlMs?: number;
  /** Rate-limiter override (defaults read ZM_RATELIMIT_MAX / _WINDOW_S). */
  rateLimit?: RateLimiterOptions;
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    },
  });

const html = (markup: string, status = 200): Response =>
  new Response(markup, {
    status,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      // The login page carries OAuth params and renders credentials forms:
      // never cache, never leak the URL via referrers, never allow framing
      // (clickjacking) or content-type sniffing.
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      'content-security-policy': "frame-ancestors 'none'",
    },
  });

const CLIENT_FALLBACK_NAME = 'An MCP client';

/** Hidden-field payload for the login form: the validated OAuth params. */
const hiddenFields = (
  params: Record<string, unknown>
): Record<string, string> =>
  Object.fromEntries(
    Object.entries(params).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string'
    )
  );

/**
 * Embedded OAuth 2.1 authorization server (MCP auth spec): RFC 8414/9728
 * metadata, RFC 7591 dynamic client registration, /oauth/authorize with
 * mandatory PKCE S256 and a self-contained Supabase Auth login page, and
 * /oauth/token returning the Supabase session pair.
 */
export const mcpAuthPlugin = (options: McpAuthPluginOptions) => {
  const deps: OAuthDeps = {
    store: options.store ?? new SupabaseOAuthStore(),
    auth: options.auth ?? new SupabaseAuthGateway(),
    issuer: options.issuer.replace(/\/$/, ''),
    codeTtlMs: options.codeTtlMs,
  };

  // Brute-force guard on the unauthenticated POST endpoints: token (code /
  // refresh-token guessing), authorize (credential stuffing), register (DCR
  // spam). Keys are per client IP per route.
  const limiterOptions = {
    ...rateLimiterOptionsFromEnv(),
    ...options.rateLimit,
  };
  const limiter = new FixedWindowRateLimiter(limiterOptions);
  const sweeper = setInterval(
    () => limiter.sweep(),
    limiterOptions.windowSeconds * 1000
  );
  sweeper.unref?.();

  const overLimit = (
    route: 'token' | 'authorize' | 'register',
    request: Request,
    server: RequestIpSource | null
  ): Response | null => {
    const decision = limiter.hit(
      `${resolveClientIp(request, server)}:${route}`
    );
    return decision.allowed
      ? null
      : rateLimitedResponse(decision.retryAfterSeconds);
  };

  return new Elysia({ name: 'mcp-auth' })
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
      const limited = overLimit('register', request, server);
      if (limited) {
        return limited;
      }
      const result = await handleRegister(deps, body);
      return json(result.body, result.status);
    })
    .get('/oauth/authorize', async ({ query }) => {
      const validation = await validateAuthorizeRequest(deps, query);
      if (!validation.ok) {
        return html(
          `<!doctype html><p>${escapeHtml(validation.message)}</p>`,
          validation.status
        );
      }
      return html(
        renderLoginPage({
          clientName: validation.client.clientName ?? CLIENT_FALLBACK_NAME,
          hiddenFields: hiddenFields(validation.params),
        })
      );
    })
    .post('/oauth/authorize', async ({ body, request, server }) => {
      const limited = overLimit('authorize', request, server);
      if (limited) {
        return limited;
      }
      const result = await handleAuthorizeSubmit(deps, body);
      if (result.kind === 'redirect') {
        return new Response(null, {
          status: 302,
          headers: { location: result.location, 'cache-control': 'no-store' },
        });
      }
      if (result.kind === 'retry') {
        const {
          email: _email,
          password: _password,
          ...oauthParams
        } = (body ?? {}) as Record<string, unknown>;
        return html(
          renderLoginPage({
            clientName: result.client.clientName ?? CLIENT_FALLBACK_NAME,
            hiddenFields: hiddenFields(oauthParams),
            errorMessage: result.message,
          }),
          401
        );
      }
      return html(
        `<!doctype html><p>${escapeHtml(result.message)}</p>`,
        result.status
      );
    })
    .post('/oauth/token', async ({ body, request, server }) => {
      const limited = overLimit('token', request, server);
      if (limited) {
        return limited;
      }
      const result = await handleToken(deps, body);
      return json(result.body, result.status);
    });
};
