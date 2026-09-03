import { randomBytes } from 'node:crypto';

import type { IAuthGateway } from './auth-gateway.js';
import type { IOAuthStore, OAuthClientRecord } from './oauth-store.js';
import {
  authorizeRequestSchema,
  authorizeSubmitSchema,
  clientRegistrationRequestSchema,
  MCP_SCOPES,
  tokenRequestSchema,
  type AuthorizeRequest,
  type OAuthErrorBody,
  type TokenResponse,
} from './oauth.schema.js';
import { verifyPkceS256 } from './pkce.js';
import {
  isAllowedRedirectUri,
  isRegisteredRedirectUri,
} from './redirect-uri.js';

const DEFAULT_CODE_TTL_MS = 5 * 60 * 1000;
const DEFAULT_EXPIRES_IN_SECONDS = 3600;

export interface OAuthDeps {
  store: IOAuthStore;
  auth: IAuthGateway;
  issuer: string;
  codeTtlMs?: number;
  now?: () => Date;
}

export interface HandlerResult<T> {
  status: number;
  body: T;
}

const oauthError = (
  status: number,
  error: string,
  description?: string
): HandlerResult<OAuthErrorBody> => ({
  status,
  body: { error, ...(description ? { error_description: description } : {}) },
});

/** Remaining lifetime of a Supabase JWT, read from its (trusted) payload. */
const jwtExpiresIn = (accessToken: string, now: Date): number => {
  try {
    const [, payload] = accessToken.split('.');
    const claims = JSON.parse(
      Buffer.from(payload ?? '', 'base64url').toString('utf8')
    ) as { exp?: number };
    if (typeof claims.exp === 'number') {
      const remaining = claims.exp - Math.floor(now.getTime() / 1000);
      return Math.max(remaining, 0);
    }
  } catch {
    // Fall through to the default: the token came from Supabase Auth itself.
  }
  return DEFAULT_EXPIRES_IN_SECONDS;
};

const tokenResponse = (
  accessToken: string,
  refreshToken: string,
  expiresIn: number
): HandlerResult<TokenResponse> => ({
  status: 200,
  body: {
    access_token: accessToken,
    token_type: 'bearer',
    expires_in: expiresIn,
    refresh_token: refreshToken,
    scope: MCP_SCOPES,
  },
});

// ── POST /oauth/register (RFC 7591) ─────────────────────────────────────────

export const handleRegister = async (
  deps: OAuthDeps,
  body: unknown
): Promise<HandlerResult<unknown>> => {
  const parsed = clientRegistrationRequestSchema.safeParse(body);
  if (!parsed.success) {
    return oauthError(
      400,
      'invalid_client_metadata',
      parsed.error.issues[0]?.message
    );
  }
  const invalidUri = parsed.data.redirect_uris.find(
    (uri) => !isAllowedRedirectUri(uri)
  );
  if (invalidUri !== undefined) {
    return oauthError(
      400,
      'invalid_redirect_uri',
      `redirect_uri "${invalidUri}" must be https, loopback http, or a private-use URI scheme`
    );
  }
  const client = await deps.store.insertClient({
    clientName: parsed.data.client_name ?? null,
    redirectUris: parsed.data.redirect_uris,
    tokenEndpointAuthMethod: parsed.data.token_endpoint_auth_method,
  });
  return {
    status: 201,
    body: {
      client_id: client.clientId,
      client_name: client.clientName ?? undefined,
      redirect_uris: client.redirectUris,
      token_endpoint_auth_method: client.tokenEndpointAuthMethod,
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      client_id_issued_at: Math.floor(
        (deps.now?.() ?? new Date()).getTime() / 1000
      ),
    },
  };
};

// ── GET/POST /oauth/authorize ────────────────────────────────────────────────

export type AuthorizeValidation =
  | { ok: true; client: OAuthClientRecord; params: AuthorizeRequest }
  | { ok: false; status: number; message: string };

/**
 * Validates an authorization request. Client/redirect_uri problems are shown
 * to the user (never redirected — an unvalidated redirect is an open
 * redirector); everything else has already pinned a safe redirect target.
 */
export const validateAuthorizeRequest = async (
  deps: OAuthDeps,
  query: unknown
): Promise<AuthorizeValidation> => {
  const parsed = authorizeRequestSchema.safeParse(query);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return {
      ok: false,
      status: 400,
      message: `Invalid authorization request: ${issue?.path.join('.') ?? ''} ${issue?.message ?? ''}`,
    };
  }
  const client = await deps.store.findClient(parsed.data.client_id);
  if (!client) {
    return { ok: false, status: 400, message: 'Unknown client_id.' };
  }
  if (!isRegisteredRedirectUri(parsed.data.redirect_uri, client.redirectUris)) {
    return {
      ok: false,
      status: 400,
      message: 'redirect_uri is not registered for this client.',
    };
  }
  return { ok: true, client, params: parsed.data };
};

export type AuthorizeSubmitResult =
  | { kind: 'redirect'; location: string }
  | { kind: 'retry'; message: string; client: OAuthClientRecord }
  | { kind: 'invalid'; status: number; message: string };

/** Handles the credentials POST: sign in, mint a one-time code, redirect. */
export const handleAuthorizeSubmit = async (
  deps: OAuthDeps,
  form: unknown
): Promise<AuthorizeSubmitResult> => {
  const parsed = authorizeSubmitSchema.safeParse(form);
  if (!parsed.success) {
    return {
      kind: 'invalid',
      status: 400,
      message: 'Invalid form submission.',
    };
  }
  const validation = await validateAuthorizeRequest(deps, parsed.data);
  if (!validation.ok) {
    return {
      kind: 'invalid',
      status: validation.status,
      message: validation.message,
    };
  }

  const session = await deps.auth.signInWithPassword(
    parsed.data.email,
    parsed.data.password
  );
  if (!session) {
    return {
      kind: 'retry',
      message: 'Invalid email or password.',
      client: validation.client,
    };
  }

  const now = deps.now?.() ?? new Date();
  const code = randomBytes(32).toString('base64url');
  await deps.store.insertCode({
    code,
    clientId: validation.client.clientId,
    userId: session.userId,
    codeChallenge: validation.params.code_challenge,
    redirectUri: validation.params.redirect_uri,
    resource: validation.params.resource ?? null,
    accessToken: session.accessToken,
    refreshToken: session.refreshToken,
    expiresAt: new Date(
      now.getTime() + (deps.codeTtlMs ?? DEFAULT_CODE_TTL_MS)
    ),
  });
  // Opportunistic housekeeping; never blocks the redirect.
  void deps.store.deleteExpiredCodes(now).catch(() => undefined);

  const location = new URL(validation.params.redirect_uri);
  location.searchParams.set('code', code);
  if (validation.params.state !== undefined) {
    location.searchParams.set('state', validation.params.state);
  }
  return { kind: 'redirect', location: location.toString() };
};

// ── POST /oauth/token ────────────────────────────────────────────────────────

/**
 * Token endpoint. authorization_code: single-use redemption (atomic in the
 * store) + PKCE S256 + client/redirect binding, then the SUPABASE session
 * captured at login is returned verbatim. refresh_token: proxied to the
 * identity gateway, returning the rotated Supabase pair.
 */
export const handleToken = async (
  deps: OAuthDeps,
  form: unknown
): Promise<HandlerResult<TokenResponse | OAuthErrorBody>> => {
  const parsed = tokenRequestSchema.safeParse(form);
  if (!parsed.success) {
    const grantType = (form as { grant_type?: unknown })?.grant_type;
    if (
      typeof grantType === 'string' &&
      !['authorization_code', 'refresh_token'].includes(grantType)
    ) {
      return oauthError(400, 'unsupported_grant_type');
    }
    return oauthError(400, 'invalid_request', parsed.error.issues[0]?.message);
  }

  const now = deps.now?.() ?? new Date();

  if (parsed.data.grant_type === 'refresh_token') {
    const session = await deps.auth.refreshSession(parsed.data.refresh_token);
    if (!session) {
      return oauthError(400, 'invalid_grant', 'Refresh token was rejected.');
    }
    return tokenResponse(
      session.accessToken,
      session.refreshToken,
      session.expiresIn
    );
  }

  const record = await deps.store.consumeCode(parsed.data.code);
  if (!record) {
    return oauthError(
      400,
      'invalid_grant',
      'Authorization code is unknown, expired, or already used.'
    );
  }
  if (
    record.clientId !== parsed.data.client_id ||
    record.redirectUri !== parsed.data.redirect_uri
  ) {
    return oauthError(
      400,
      'invalid_grant',
      'Authorization code was issued to a different client or redirect_uri.'
    );
  }
  if (!verifyPkceS256(parsed.data.code_verifier, record.codeChallenge)) {
    return oauthError(400, 'invalid_grant', 'PKCE verification failed.');
  }
  return tokenResponse(
    record.accessToken,
    record.refreshToken,
    jwtExpiresIn(record.accessToken, now)
  );
};
