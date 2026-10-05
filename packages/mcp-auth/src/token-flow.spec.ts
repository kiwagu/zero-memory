import { randomBytes, randomUUID } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import type { AuthSession, IAuthGateway } from './auth-gateway.js';
import {
  handleAuthorizationRead,
  handleAuthorizeStart,
  handleConsentDecision,
  handleRegister,
  handleToken,
  validateAuthorizeRequest,
  type OAuthDeps,
} from './handlers.js';
import { parseGrantToken } from './grant-token.js';
import { InMemoryOAuthStore } from './in-memory-oauth-store.js';
import type { TokenResponse } from './oauth.schema.js';
import { computeS256Challenge } from './pkce.js';

const ISSUER = 'http://localhost:8787';
const REDIRECT_URI = 'http://127.0.0.1:41241/callback';
const USER_ID = 'b7e6a1c2-3d4f-4a5b-8c9d-0e1f2a3b4c5d';

/** Unsigned JWT with an exp claim ~1h out — enough for expires_in math. */
const makeJwt = (expiresInSeconds = 3600): string => {
  const payload = Buffer.from(
    JSON.stringify({
      sub: USER_ID,
      exp: Math.floor(Date.now() / 1000) + expiresInSeconds,
    })
  ).toString('base64url');
  return `header.${payload}.signature`;
};

const makeSession = (): AuthSession => ({
  userId: USER_ID,
  email: 'alice@example.com',
  accessToken: makeJwt(),
  refreshToken: randomBytes(16).toString('base64url'),
  expiresIn: 3600,
  sessionId: randomUUID(),
});

const makeAuthGateway = (session: AuthSession | null = makeSession()) =>
  ({
    verifyAccessToken: vi
      .fn()
      .mockResolvedValue(
        session ? { userId: session.userId, owesSecondFactor: false } : null
      ),
    mintSession: vi.fn().mockResolvedValue(session),
    refreshSession: vi
      .fn()
      .mockResolvedValue(
        session ? { kind: 'refreshed', session } : { kind: 'ended' }
      ),
    revokeSession: vi.fn().mockResolvedValue(undefined),
  }) satisfies IAuthGateway;

const makeDeps = (auth: IAuthGateway = makeAuthGateway()): OAuthDeps => ({
  store: new InMemoryOAuthStore(),
  auth,
  issuer: ISSUER,
  webUrl: 'http://localhost:3100',
});

const registerClient = async (deps: OAuthDeps): Promise<string> => {
  const result = await handleRegister(deps, {
    client_name: 'smoke client',
    redirect_uris: [REDIRECT_URI],
    token_endpoint_auth_method: 'none',
  });
  expect(result.status).toBe(201);
  return (result.body as { client_id: string }).client_id;
};

/**
 * Drives the consent flow (start, the person approves on the dashboard) and
 * returns the one-time code from the redirect back to the client.
 */
const obtainCode = async (
  deps: OAuthDeps,
  clientId: string,
  challenge: string
): Promise<{ code: string; state: string | null }> => {
  const started = await handleAuthorizeStart(deps, {
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    response_type: 'code',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state: 'xyz',
  });
  if (started.kind !== 'redirect') {
    throw new Error('expected redirect');
  }
  const authorizationId =
    new URL(started.location).searchParams.get('authorization_id') ?? '';
  const signedIn = { authorizationId, authorization: 'Bearer dashboard' };
  await handleAuthorizationRead(deps, signedIn);
  const decided = await handleConsentDecision(deps, {
    ...signedIn,
    body: { decision: 'approve' },
  });
  expect(decided.status).toBe(200);
  const url = new URL((decided.body as { redirect_url: string }).redirect_url);
  expect(url.origin + url.pathname).toBe(REDIRECT_URI);
  return {
    code: url.searchParams.get('code') ?? '',
    state: url.searchParams.get('state'),
  };
};

describe('dynamic client registration', () => {
  it('registers a public client and returns its metadata', async () => {
    const deps = makeDeps();
    const result = await handleRegister(deps, {
      client_name: 'claude',
      redirect_uris: ['https://claude.ai/api/mcp/auth_callback'],
    });
    expect(result.status).toBe(201);
    expect(result.body).toMatchObject({
      client_name: 'claude',
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
    });
  });

  it('rejects non-loopback http redirect uris', async () => {
    const deps = makeDeps();
    const result = await handleRegister(deps, {
      redirect_uris: ['http://evil.example.com/cb'],
    });
    expect(result.status).toBe(400);
    expect(result.body).toMatchObject({ error: 'invalid_redirect_uri' });
  });
});

describe('authorize request validation', () => {
  it('rejects unknown clients and unregistered redirect uris', async () => {
    const deps = makeDeps();
    const clientId = await registerClient(deps);

    const unknownClient = await validateAuthorizeRequest(deps, {
      // Well-formed oac_ id that was never registered — exercises the client
      // lookup, not the schema (a malformed id would fail earlier).
      client_id: 'oac_0000000000000000.0000000000',
      redirect_uri: REDIRECT_URI,
      response_type: 'code',
      code_challenge: 'a'.repeat(43),
      code_challenge_method: 'S256',
    });
    expect(unknownClient.ok).toBe(false);

    const wrongRedirect = await validateAuthorizeRequest(deps, {
      client_id: clientId,
      redirect_uri: 'http://127.0.0.1:41241/other',
      response_type: 'code',
      code_challenge: 'a'.repeat(43),
      code_challenge_method: 'S256',
    });
    expect(wrongRedirect.ok).toBe(false);
  });

  it('requires PKCE S256 — plain or missing challenges are rejected', async () => {
    const deps = makeDeps();
    const clientId = await registerClient(deps);

    const missing = await validateAuthorizeRequest(deps, {
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
      response_type: 'code',
    });
    expect(missing.ok).toBe(false);

    const plain = await validateAuthorizeRequest(deps, {
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
      response_type: 'code',
      code_challenge: 'a'.repeat(43),
      code_challenge_method: 'plain',
    });
    expect(plain.ok).toBe(false);
  });
});

describe('token flow', () => {
  it("redeems the code for the agent session and a refresh token of the server's own", async () => {
    const session = makeSession();
    const deps = makeDeps(makeAuthGateway(session));
    const clientId = await registerClient(deps);
    const verifier = randomBytes(48).toString('base64url');
    const { code, state } = await obtainCode(
      deps,
      clientId,
      computeS256Challenge(verifier)
    );
    expect(state).toBe('xyz');

    const result = await handleToken(deps, {
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier,
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
    });

    expect(result.status).toBe(200);
    const body = result.body as TokenResponse;
    expect(body.access_token).toBe(session.accessToken);
    // Not Auth's own refresh token: one that names the agent's grant.
    expect(body.refresh_token).not.toBe(session.refreshToken);
    expect(parseGrantToken(body.refresh_token)).toMatchObject({
      generation: 0,
    });
    expect(body.token_type).toBe('bearer');
    expect(body.scope).toBe('mcp:read mcp:write');
    expect(body.expires_in).toBeGreaterThan(3500);
    expect(body.expires_in).toBeLessThanOrEqual(3600);
  });

  it('enforces single-use codes', async () => {
    const deps = makeDeps();
    const clientId = await registerClient(deps);
    const verifier = randomBytes(48).toString('base64url');
    const { code } = await obtainCode(
      deps,
      clientId,
      computeS256Challenge(verifier)
    );
    const grant = {
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier,
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
    };

    expect((await handleToken(deps, grant)).status).toBe(200);
    const replay = await handleToken(deps, grant);
    expect(replay.status).toBe(400);
    expect(replay.body).toMatchObject({ error: 'invalid_grant' });
  });

  it('rejects a wrong PKCE verifier and burns the code', async () => {
    const deps = makeDeps();
    const clientId = await registerClient(deps);
    const verifier = randomBytes(48).toString('base64url');
    const { code } = await obtainCode(
      deps,
      clientId,
      computeS256Challenge(verifier)
    );

    const wrong = await handleToken(deps, {
      grant_type: 'authorization_code',
      code,
      code_verifier: randomBytes(48).toString('base64url'),
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
    });
    expect(wrong.status).toBe(400);
    expect(wrong.body).toMatchObject({ error: 'invalid_grant' });

    // The consume-first semantics burned the code: the right verifier is
    // now useless too (no second chance after a failed redemption).
    const retry = await handleToken(deps, {
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier,
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
    });
    expect(retry.status).toBe(400);
  });

  it('rejects a code presented by another client or redirect_uri', async () => {
    const deps = makeDeps();
    const clientId = await registerClient(deps);
    const otherClientId = await registerClient(deps);
    const verifier = randomBytes(48).toString('base64url');
    const { code } = await obtainCode(
      deps,
      clientId,
      computeS256Challenge(verifier)
    );

    const stolen = await handleToken(deps, {
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier,
      client_id: otherClientId,
      redirect_uri: REDIRECT_URI,
    });
    expect(stolen.status).toBe(400);
    expect(stolen.body).toMatchObject({ error: 'invalid_grant' });
  });

  it('rejects expired codes', async () => {
    const deps = { ...makeDeps(), codeTtlMs: -1000 };
    const clientId = await registerClient(deps);
    const verifier = randomBytes(48).toString('base64url');
    const { code } = await obtainCode(
      deps,
      clientId,
      computeS256Challenge(verifier)
    );

    const expired = await handleToken(deps, {
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier,
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
    });
    expect(expired.status).toBe(400);
  });

  it('rejects unsupported grant types', async () => {
    const deps = makeDeps();
    const result = await handleToken(deps, {
      grant_type: 'client_credentials',
    });
    expect(result.status).toBe(400);
    expect(result.body).toMatchObject({ error: 'unsupported_grant_type' });
  });
});

/** An agent that went through the consent flow, with the tokens it holds. */
const connect = async (deps: OAuthDeps) => {
  const clientId = await registerClient(deps);
  const verifier = randomBytes(48).toString('base64url');
  const { code } = await obtainCode(
    deps,
    clientId,
    computeS256Challenge(verifier)
  );
  const redeemed = await handleToken(deps, {
    grant_type: 'authorization_code',
    code,
    code_verifier: verifier,
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
  });
  expect(redeemed.status).toBe(200);
  return { clientId, tokens: redeemed.body as TokenResponse };
};

const refresh = (deps: OAuthDeps, refreshToken: string, clientId?: string) =>
  handleToken(deps, {
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    ...(clientId ? { client_id: clientId } : {}),
  });

describe("refreshing an agent's grant", () => {
  it('renews the session and hands out the next refresh token', async () => {
    const session = makeSession();
    const auth = makeAuthGateway(session);
    const deps = makeDeps(auth);
    const { clientId, tokens } = await connect(deps);
    const rotated = makeSession();
    vi.mocked(auth.refreshSession).mockResolvedValue({
      kind: 'refreshed',
      session: rotated,
    });

    const result = await refresh(deps, tokens.refresh_token, clientId);

    expect(result.status).toBe(200);
    const body = result.body as TokenResponse;
    expect(body.access_token).toBe(rotated.accessToken);
    expect(parseGrantToken(body.refresh_token)?.generation).toBe(1);
    // Auth is asked with ITS refresh token, which the agent never saw.
    expect(auth.refreshSession).toHaveBeenCalledExactlyOnceWith(
      session.refreshToken
    );
  });

  it('answers two refreshes that raced with the same pair', async () => {
    const auth = makeAuthGateway();
    // One instant for both, as for two requests that truly raced: the second
    // pair's expires_in is counted from the clock.
    const now = new Date();
    const deps = { ...makeDeps(auth), now: () => now };
    const { tokens } = await connect(deps);

    const first = await refresh(deps, tokens.refresh_token);
    const second = await refresh(deps, tokens.refresh_token);

    expect(second.status).toBe(200);
    expect(second.body).toEqual(first.body);
    expect(auth.refreshSession).toHaveBeenCalledTimes(1);
  });

  it('ends the grant when a token it already replaced comes back later', async () => {
    let now = new Date();
    const deps = { ...makeDeps(), now: () => now };
    const { tokens } = await connect(deps);
    const next = (await refresh(deps, tokens.refresh_token))
      .body as TokenResponse;

    now = new Date(now.getTime() + 5 * 60 * 1000);
    const replayed = await refresh(deps, tokens.refresh_token);
    expect(replayed.status).toBe(400);
    expect(replayed.body).toMatchObject({ error: 'invalid_grant' });
    // Copied, so the grant is not shared: the latest token is refused too.
    expect((await refresh(deps, next.refresh_token)).status).toBe(400);
  });

  it('opens a new session when Auth ended the old one and nothing about the account changed', async () => {
    const session = makeSession();
    const auth = makeAuthGateway(session);
    const deps = makeDeps(auth);
    const { clientId, tokens } = await connect(deps);
    const store = deps.store as InMemoryOAuthStore;
    // The person gave the second factor: Auth deleted every weaker session.
    vi.mocked(auth.refreshSession).mockResolvedValue({ kind: 'ended' });
    const reopened = makeSession();
    vi.mocked(auth.mintSession).mockResolvedValue(reopened);

    const result = await refresh(deps, tokens.refresh_token, clientId);

    expect(result.status).toBe(200);
    expect((result.body as TokenResponse).access_token).toBe(
      reopened.accessToken
    );
    expect(store.agentSessions().get(reopened.sessionId!)).toEqual({
      authUserId: USER_ID,
      clientId,
    });
    expect(store.agentSessions().has(session.sessionId!)).toBe(false);
  });

  it("ends the grant instead when the account's password or factors changed", async () => {
    const auth = makeAuthGateway();
    const deps = makeDeps(auth);
    const { tokens } = await connect(deps);
    (deps.store as InMemoryOAuthStore).changeCredentials(USER_ID);
    vi.mocked(auth.refreshSession).mockResolvedValue({ kind: 'ended' });
    vi.mocked(auth.mintSession).mockClear();

    const result = await refresh(deps, tokens.refresh_token);

    expect(result.status).toBe(400);
    expect(result.body).toMatchObject({ error: 'invalid_grant' });
    expect(auth.mintSession).not.toHaveBeenCalled();
  });

  it('ends the grant when the person withdrew consent', async () => {
    const deps = makeDeps();
    const { clientId, tokens } = await connect(deps);
    (deps.store as InMemoryOAuthStore).withdrawConsent(USER_ID, clientId);

    const result = await refresh(deps, tokens.refresh_token);
    expect(result.status).toBe(400);
    expect(result.body).toMatchObject({ error: 'invalid_grant' });
  });

  it('keeps the token valid when Auth could not be asked', async () => {
    const auth = makeAuthGateway();
    const deps = makeDeps(auth);
    const { tokens } = await connect(deps);
    vi.mocked(auth.refreshSession).mockResolvedValueOnce({
      kind: 'unavailable',
    });

    const down = await refresh(deps, tokens.refresh_token);
    expect(down.status).toBe(503);
    expect(down.body).toMatchObject({ error: 'temporarily_unavailable' });
    expect((await refresh(deps, tokens.refresh_token)).status).toBe(200);
  });

  it('refuses a token of another client, an Auth token and a forged one', async () => {
    const deps = makeDeps();
    const { tokens } = await connect(deps);
    const otherClientId = await registerClient(deps);
    const parsed = parseGrantToken(tokens.refresh_token)!;

    expect(
      (await refresh(deps, tokens.refresh_token, otherClientId)).status
    ).toBe(400);
    expect((await refresh(deps, 'v1-auth-refresh-token')).status).toBe(400);
    expect(
      (await refresh(deps, `${parsed.grantId}~0~not-the-signature`)).status
    ).toBe(400);
  });

  it('ends the earlier grant when the same client is authorized again', async () => {
    const deps = makeDeps();
    const { clientId, tokens } = await connect(deps);
    const verifier = randomBytes(48).toString('base64url');
    const { code } = await obtainCode(
      deps,
      clientId,
      computeS256Challenge(verifier)
    );
    await handleToken(deps, {
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier,
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
    });

    expect((await refresh(deps, tokens.refresh_token)).status).toBe(400);
  });
});
