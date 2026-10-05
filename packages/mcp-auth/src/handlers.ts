import { randomBytes } from 'node:crypto';

import type { AuthSession, IAuthGateway } from './auth-gateway.js';
import type {
  IOAuthStore,
  OAuthAuthorizationRecord,
  OAuthClientRecord,
  OAuthConsentRecord,
} from './oauth-store.js';
import {
  authorizationDetailsSchema,
  authorizationIdSchema,
  authorizeRequestSchema,
  clientRegistrationRequestSchema,
  consentDecisionSchema,
  MCP_SCOPES,
  tokenRequestSchema,
  type AuthorizationDetails,
  type AuthorizeRequest,
  type ConsentResult,
  type OAuthErrorBody,
  type TokenResponse,
} from './oauth.schema.js';
import { verifyPkceS256 } from './pkce.js';
import {
  isAllowedRedirectUri,
  isRegisteredRedirectUri,
  mixesRemoteAndLocal,
} from './redirect-uri.js';

const DEFAULT_CODE_TTL_MS = 5 * 60 * 1000;
/** Long enough to sign in with a provider and read the screen, no longer. */
const DEFAULT_AUTHORIZATION_TTL_MS = 10 * 60 * 1000;
const DEFAULT_EXPIRES_IN_SECONDS = 3600;

export interface OAuthDeps {
  store: IOAuthStore;
  auth: IAuthGateway;
  issuer: string;
  /** External origin of the dashboard, where the person decides. */
  webUrl: string;
  codeTtlMs?: number;
  authorizationTtlMs?: number;
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
  if (mixesRemoteAndLocal(parsed.data.redirect_uris)) {
    return oauthError(
      400,
      'invalid_redirect_uri',
      'redirect_uris must be all https, or all loopback http and private-use schemes: a client returns either to a remote host or to the local machine'
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

// ── GET /oauth/authorize ─────────────────────────────────────────────────────

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

export type AuthorizeStartResult =
  | { kind: 'redirect'; location: string }
  | { kind: 'invalid'; status: number; message: string };

/**
 * Parks a validated request as a pending authorization and sends the person
 * to the dashboard's consent page, where they sign in however the instance
 * allows and decide. Nothing about the request travels in that URL but its id.
 */
export const handleAuthorizeStart = async (
  deps: OAuthDeps,
  query: unknown
): Promise<AuthorizeStartResult> => {
  const validation = await validateAuthorizeRequest(deps, query);
  if (!validation.ok) {
    return {
      kind: 'invalid',
      status: validation.status,
      message: validation.message,
    };
  }
  const now = deps.now?.() ?? new Date();
  const authorization = await deps.store.insertAuthorization({
    clientId: validation.client.clientId,
    redirectUri: validation.params.redirect_uri,
    codeChallenge: validation.params.code_challenge,
    state: validation.params.state ?? null,
    resource: validation.params.resource ?? null,
    scope: MCP_SCOPES,
    expiresAt: new Date(
      now.getTime() + (deps.authorizationTtlMs ?? DEFAULT_AUTHORIZATION_TTL_MS)
    ),
  });
  // Opportunistic housekeeping; never blocks the redirect.
  void deps.store.deleteExpiredAuthorizations(now).catch(() => undefined);

  const location = new URL('/oauth/consent', deps.webUrl);
  location.searchParams.set('authorization_id', authorization.id);
  return { kind: 'redirect', location: location.toString() };
};

// ── GET /oauth/authorizations/:id, POST …/consent (dashboard, Bearer) ────────

export interface AuthorizationRequestInput {
  /** The `:id` path segment, untrusted. */
  authorizationId: string;
  /** The raw `Authorization` header: the person's dashboard session. */
  authorization: string | null | undefined;
  /**
   * Whether a client the person already approved may be sent straight back
   * without a screen. The dashboard says so only when the browser arrived on
   * its own, as it does when a client opens the authorize URL, or from the
   * dashboard's own origin; a navigation another site set off gets the screen
   * and the person's click, however often it comes. Absent reads as false.
   */
  screenless?: boolean;
}

const NOT_FOUND = oauthError(
  404,
  'not_found',
  'No pending authorization with this id is waiting for you.'
);

/**
 * Who is deciding, from the `Bearer` dashboard session. Granting an agent is
 * what the second factor guards, so a session that still owes its code is
 * refused here as well as by the page in front: an agent's own session, or a
 * stolen password without the phone, must not reach the consent API directly.
 */
const authenticate = async (
  deps: OAuthDeps,
  header: string | null | undefined
): Promise<
  | { kind: 'ok'; userId: string }
  | { kind: 'refused'; result: HandlerResult<OAuthErrorBody> }
> => {
  const token = header?.startsWith('Bearer ')
    ? header.slice('Bearer '.length).trim()
    : '';
  const verified =
    token === '' ? null : await deps.auth.verifyAccessToken(token);
  if (!verified) {
    return {
      kind: 'refused',
      result: oauthError(
        401,
        'invalid_token',
        'Sign in to the dashboard first.'
      ),
    };
  }
  if (verified.owesSecondFactor) {
    return {
      kind: 'refused',
      result: oauthError(
        403,
        'insufficient_aal',
        'Give the code from your authenticator app first.'
      ),
    };
  }
  return { kind: 'ok', userId: verified.userId };
};

/**
 * The person already approved this request: every scope it asks for, and the
 * return address it names. The address is what the consent screen shows to
 * tell a genuine client from one that merely took its name, so an approval
 * given for one address never carries over to another the same client
 * registered. Loopback addresses compare without the port, as registration
 * does.
 */
const consentCovers = (
  consent: OAuthConsentRecord,
  authorization: OAuthAuthorizationRecord
): boolean => {
  if (
    !isRegisteredRedirectUri(authorization.redirectUri, [consent.redirectUri])
  ) {
    return false;
  }
  const grantedScopes = new Set(consent.scope.split(' ').filter(Boolean));
  return authorization.scope
    .split(' ')
    .filter(Boolean)
    .every((scope) => grantedScopes.has(scope));
};

const backToClient = (
  authorization: OAuthAuthorizationRecord,
  params: Record<string, string>
): HandlerResult<ConsentResult> => {
  const location = new URL(authorization.redirectUri);
  for (const [key, value] of Object.entries(params)) {
    location.searchParams.set(key, value);
  }
  if (authorization.state !== null) {
    location.searchParams.set('state', authorization.state);
  }
  return { status: 200, body: { redirect_url: location.toString() } };
};

/**
 * Approves on the person's behalf: the decision is taken first (exactly once),
 * then a session of the agent's own is minted and parked behind a one-time
 * code, and the consent is remembered for next time, for the return address
 * the person approved. A mint failure leaves the request approved without a
 * code; the client simply starts over.
 */
const approve = async (
  deps: OAuthDeps,
  authorization: OAuthAuthorizationRecord,
  userId: string,
  now: Date
): Promise<HandlerResult<ConsentResult | OAuthErrorBody>> => {
  const decided = await deps.store.decideAuthorization(
    authorization.id,
    userId,
    'approved',
    now
  );
  if (!decided) {
    return oauthError(
      409,
      'invalid_request',
      'This authorization was already decided.'
    );
  }
  const session = await deps.auth.mintSession(userId);
  if (!session) {
    return oauthError(
      503,
      'server_error',
      'The agent session could not be created. Connect the client again.'
    );
  }
  // What follows the mint is what makes the session reachable: the record
  // that marks it as an agent's (without it, an account with a second factor
  // would refuse the session its data), the code the client redeems, and the
  // consent for next time. If any of them fails, the session would stay
  // alive with no one to hold it, so it is ended first.
  let code: string;
  try {
    await recordAgentSession(deps, decided, session);
    code = await issueCode(deps, decided, session, now);
    await deps.store.upsertConsent(
      userId,
      decided.clientId,
      decided.scope,
      decided.redirectUri
    );
  } catch (thrown) {
    await deps.auth.revokeSession(session);
    throw thrown;
  }
  return backToClient(decided, { code });
};

/**
 * Marks the minted session as an agent's. A session whose token names no
 * session id cannot be marked, and an unmarked session on an account with a
 * second factor would be refused its data; failing here, before the code is
 * issued, is what keeps that from being discovered by the agent.
 */
const recordAgentSession = async (
  deps: OAuthDeps,
  authorization: OAuthAuthorizationRecord,
  session: AuthSession
): Promise<void> => {
  if (session.sessionId === null) {
    throw new Error('The minted session carries no session id.');
  }
  await deps.store.recordAgentSession({
    sessionId: session.sessionId,
    authUserId: session.userId,
    clientId: authorization.clientId,
  });
};

const issueCode = async (
  deps: OAuthDeps,
  authorization: OAuthAuthorizationRecord,
  session: AuthSession,
  now: Date
): Promise<string> => {
  const code = randomBytes(32).toString('base64url');
  await deps.store.insertCode({
    code,
    clientId: authorization.clientId,
    userId: session.userId,
    codeChallenge: authorization.codeChallenge,
    redirectUri: authorization.redirectUri,
    resource: authorization.resource,
    accessToken: session.accessToken,
    refreshToken: session.refreshToken,
    expiresAt: new Date(
      now.getTime() + (deps.codeTtlMs ?? DEFAULT_CODE_TTL_MS)
    ),
  });
  // Opportunistic housekeeping; never blocks the redirect.
  void deps.store.deleteExpiredCodes(now).catch(() => undefined);
  return code;
};

/**
 * What the consent screen shows. The first signed-in reader binds the request
 * to themselves; anyone else gets 404. When a stored consent already covers
 * the request, it is approved on the spot and the answer is where to go next.
 */
export const handleAuthorizationRead = async (
  deps: OAuthDeps,
  input: AuthorizationRequestInput
): Promise<
  HandlerResult<AuthorizationDetails | ConsentResult | OAuthErrorBody>
> => {
  const caller = await authenticate(deps, input.authorization);
  if (caller.kind === 'refused') {
    return caller.result;
  }
  const userId = caller.userId;
  const id = authorizationIdSchema.safeParse(input.authorizationId);
  if (!id.success) {
    return NOT_FOUND;
  }
  const now = deps.now?.() ?? new Date();
  const authorization = await deps.store.bindAuthorization(
    id.data,
    userId,
    now
  );
  if (!authorization) {
    return NOT_FOUND;
  }
  const client = await deps.store.findClient(authorization.clientId);
  if (!client) {
    return NOT_FOUND;
  }
  const consent = await deps.store.findConsent(userId, client.clientId);
  if (
    input.screenless === true &&
    consent &&
    consentCovers(consent, authorization)
  ) {
    return approve(deps, authorization, userId, now);
  }
  return {
    status: 200,
    // Parsed on the way out: the store's ids become the contract's branded ones.
    body: authorizationDetailsSchema.parse({
      authorization_id: authorization.id,
      client: { client_id: client.clientId, client_name: client.clientName },
      scope: authorization.scope,
      redirect_uri: authorization.redirectUri,
      expires_at: authorization.expiresAt.toISOString(),
    }),
  };
};

/**
 * The person's decision. Allowed only to whoever the request is bound to (a
 * decision by the first signed-in person binds it as a read would); taken
 * once. Either way the answer is where the browser goes next: the client's
 * redirect URI with a code, or with `error=access_denied`.
 */
export const handleConsentDecision = async (
  deps: OAuthDeps,
  input: AuthorizationRequestInput & { body: unknown }
): Promise<HandlerResult<ConsentResult | OAuthErrorBody>> => {
  const caller = await authenticate(deps, input.authorization);
  if (caller.kind === 'refused') {
    return caller.result;
  }
  const userId = caller.userId;
  const decision = consentDecisionSchema.safeParse(input.body);
  if (!decision.success) {
    return oauthError(400, 'invalid_request', 'Decide "approve" or "deny".');
  }
  const id = authorizationIdSchema.safeParse(input.authorizationId);
  if (!id.success) {
    return NOT_FOUND;
  }
  const now = deps.now?.() ?? new Date();
  const authorization = await deps.store.bindAuthorization(
    id.data,
    userId,
    now
  );
  if (!authorization) {
    return NOT_FOUND;
  }
  if (decision.data.decision === 'approve') {
    return approve(deps, authorization, userId, now);
  }
  const denied = await deps.store.decideAuthorization(
    authorization.id,
    userId,
    'denied',
    now
  );
  if (!denied) {
    return oauthError(
      409,
      'invalid_request',
      'This authorization was already decided.'
    );
  }
  return backToClient(denied, { error: 'access_denied' });
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
