import { randomBytes } from 'node:crypto';

import type { AuthSession, IAuthGateway } from './auth-gateway.js';
import {
  grantToken,
  grantTokenIsSigned,
  newGrantSecret,
  parseGrantToken,
} from './grant-token.js';
import type {
  AgentGrantRecord,
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
/**
 * How long the refresh token one generation behind is still honoured: two
 * refreshes of the same agent that raced (a hook and a long-running process
 * on one machine) both leave with the pair of the one that won.
 */
const REFRESH_RACE_WINDOW_MS = 60 * 1000;

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
    const refreshToken = await openGrant(deps, decided, session, now);
    code = await issueCode(deps, decided, session, refreshToken, now);
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

/**
 * Opens the grant the agent's refresh token will stand for, and returns that
 * token. A client that authorizes again leaves its earlier grant behind for
 * good: whatever held that token is no longer this client's.
 */
const openGrant = async (
  deps: OAuthDeps,
  authorization: OAuthAuthorizationRecord,
  session: AuthSession,
  now: Date
): Promise<string> => {
  const fingerprint = await deps.store.credentialsFingerprint(session.userId);
  if (fingerprint === null || session.sessionId === null) {
    throw new Error('The minted session cannot be held by a grant.');
  }
  await deps.store.revokeClientGrants(
    session.userId,
    authorization.clientId,
    now
  );
  const grant = await deps.store.insertGrant({
    authUserId: session.userId,
    clientId: authorization.clientId,
    scope: authorization.scope,
    tokenSecret: newGrantSecret(),
    accessToken: session.accessToken,
    accessExpiresAt: new Date(now.getTime() + session.expiresIn * 1000),
    authRefreshToken: session.refreshToken,
    sessionId: session.sessionId,
    credentialsFingerprint: fingerprint,
  });
  return grantToken(grant.id, grant.generation, grant.tokenSecret);
};

const issueCode = async (
  deps: OAuthDeps,
  authorization: OAuthAuthorizationRecord,
  session: AuthSession,
  refreshToken: string,
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
    refreshToken,
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

const refusedGrant = (description: string): HandlerResult<OAuthErrorBody> =>
  oauthError(400, 'invalid_grant', description);

/** The pair a grant last handed out, for a refresh that raced it. */
const currentPair = (
  grant: AgentGrantRecord,
  now: Date
): HandlerResult<TokenResponse> =>
  tokenResponse(
    grant.accessToken,
    grantToken(grant.id, grant.generation, grant.tokenSecret),
    Math.max(
      Math.floor((grant.accessExpiresAt.getTime() - now.getTime()) / 1000),
      0
    )
  );

type Renewal =
  | { kind: 'renewed'; session: AuthSession; minted: boolean }
  | { kind: 'ended' }
  | { kind: 'unavailable' };

/**
 * A fresh session for the grant. Auth's own refresh first; when Auth has
 * ended the session, a new one is opened — unless the account's password or
 * verified factors changed since, which is when a person means to shut out
 * whoever held its sessions. The ending that remains is the person giving a
 * second factor, which makes Auth delete every weaker session, an agent's
 * included; the agent should not notice that.
 */
const renewSession = async (
  deps: OAuthDeps,
  grant: AgentGrantRecord
): Promise<Renewal> => {
  const refreshed = await deps.auth.refreshSession(grant.authRefreshToken);
  if (refreshed.kind === 'refreshed') {
    return { kind: 'renewed', session: refreshed.session, minted: false };
  }
  if (refreshed.kind === 'unavailable') {
    return refreshed;
  }
  const fingerprint = await deps.store.credentialsFingerprint(grant.authUserId);
  if (fingerprint === null || fingerprint !== grant.credentialsFingerprint) {
    return { kind: 'ended' };
  }
  const minted = await deps.auth.mintSession(grant.authUserId);
  if (!minted) {
    return { kind: 'unavailable' };
  }
  if (minted.sessionId === null) {
    await deps.auth.revokeSession(minted);
    return { kind: 'unavailable' };
  }
  try {
    await deps.store.recordAgentSession({
      sessionId: minted.sessionId,
      authUserId: grant.authUserId,
      clientId: grant.clientId,
    });
    await deps.store.forgetAgentSession(grant.sessionId);
  } catch (thrown) {
    await deps.auth.revokeSession(minted);
    throw thrown;
  }
  return { kind: 'renewed', session: minted, minted: true };
};

/**
 * refresh_token grant. The token is the authorization server's own: it names
 * a grant and its generation, signed with the grant's secret. Only the token
 * of the grant's current generation renews it (one generation behind is
 * answered with the current pair within a short window, for two refreshes
 * that raced); an older one was copied, and the grant ends rather than being
 * shared. A grant whose consent was withdrawn ends too.
 */
const refreshGrant = async (
  deps: OAuthDeps,
  request: { refresh_token: string; client_id?: string },
  now: Date
): Promise<HandlerResult<TokenResponse | OAuthErrorBody>> => {
  const presented = parseGrantToken(request.refresh_token);
  const grant = presented
    ? await deps.store.findGrant(presented.grantId)
    : null;
  if (
    !presented ||
    !grant ||
    !grantTokenIsSigned(presented, grant.tokenSecret) ||
    grant.revokedAt !== null
  ) {
    return refusedGrant('Refresh token was rejected.');
  }
  if (request.client_id !== undefined && request.client_id !== grant.clientId) {
    return refusedGrant('Refresh token was issued to a different client.');
  }
  if (
    presented.generation === grant.generation - 1 &&
    now.getTime() - grant.rotatedAt.getTime() < REFRESH_RACE_WINDOW_MS
  ) {
    return currentPair(grant, now);
  }
  if (presented.generation !== grant.generation) {
    await deps.store.revokeGrant(grant.id, now);
    return refusedGrant('Refresh token was already used.');
  }
  const consent = await deps.store.findConsent(
    grant.authUserId,
    grant.clientId
  );
  if (!consent) {
    await deps.store.revokeGrant(grant.id, now);
    return refusedGrant(
      'The person no longer allows this client. Authorize it again.'
    );
  }

  const renewal = await renewSession(deps, grant);
  if (renewal.kind === 'unavailable') {
    return oauthError(
      503,
      'temporarily_unavailable',
      'The sign-in service could not be reached. Try again.'
    );
  }
  if (renewal.kind === 'ended') {
    await deps.store.revokeGrant(grant.id, now);
    return refusedGrant(
      "The account's password or second factor changed. Authorize the client again."
    );
  }

  const { session } = renewal;
  const advanced = await deps.store.advanceGrant(
    grant.id,
    grant.generation,
    {
      accessToken: session.accessToken,
      accessExpiresAt: new Date(now.getTime() + session.expiresIn * 1000),
      authRefreshToken: session.refreshToken,
      sessionId: session.sessionId ?? grant.sessionId,
    },
    now
  );
  if (!advanced) {
    // Another refresh moved the grant first; hand back what it got.
    if (renewal.minted) {
      await deps.auth.revokeSession(session);
    }
    const current = await deps.store.findGrant(grant.id);
    return current &&
      current.revokedAt === null &&
      current.generation === grant.generation + 1
      ? currentPair(current, now)
      : refusedGrant('Refresh token was rejected.');
  }
  return tokenResponse(
    session.accessToken,
    grantToken(grant.id, grant.generation + 1, grant.tokenSecret),
    session.expiresIn
  );
};

/**
 * Token endpoint. authorization_code: single-use redemption (atomic in the
 * store) + PKCE S256 + client/redirect binding, then the agent's Supabase
 * access token and the server's own refresh token for its grant.
 * refresh_token: the grant is renewed (see refreshGrant).
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
    return refreshGrant(deps, parsed.data, now);
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
