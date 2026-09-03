import { randomBytes } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import type { AuthSession, IAuthGateway } from './auth-gateway.js';
import {
  handleAuthorizeSubmit,
  handleRegister,
  handleToken,
  validateAuthorizeRequest,
  type OAuthDeps,
} from './handlers.js';
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
});

const makeAuthGateway = (session: AuthSession | null = makeSession()) =>
  ({
    signInWithPassword: vi.fn().mockResolvedValue(session),
    refreshSession: vi.fn().mockResolvedValue(session),
  }) satisfies IAuthGateway;

const makeDeps = (auth: IAuthGateway = makeAuthGateway()): OAuthDeps => ({
  store: new InMemoryOAuthStore(),
  auth,
  issuer: ISSUER,
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

/** Drives authorize POST and returns the one-time code from the redirect. */
const obtainCode = async (
  deps: OAuthDeps,
  clientId: string,
  challenge: string
): Promise<{ code: string; state: string | null }> => {
  const submitted = await handleAuthorizeSubmit(deps, {
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    response_type: 'code',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state: 'xyz',
    email: 'alice@example.com',
    password: 'pw',
  });
  expect(submitted.kind).toBe('redirect');
  if (submitted.kind !== 'redirect') {
    throw new Error('expected redirect');
  }
  const url = new URL(submitted.location);
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
  it('round-trips the Supabase session through code + PKCE redemption', async () => {
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
    expect(body.refresh_token).toBe(session.refreshToken);
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

  it('proxies refresh_token grants to the identity gateway', async () => {
    const rotated = makeSession();
    const auth = makeAuthGateway();
    vi.mocked(auth.refreshSession).mockResolvedValue(rotated);
    const deps = makeDeps(auth);

    const result = await handleToken(deps, {
      grant_type: 'refresh_token',
      refresh_token: 'old-refresh-token',
    });

    expect(result.status).toBe(200);
    expect(auth.refreshSession).toHaveBeenCalledExactlyOnceWith(
      'old-refresh-token'
    );
    expect((result.body as TokenResponse).access_token).toBe(
      rotated.accessToken
    );

    vi.mocked(auth.refreshSession).mockResolvedValue(null);
    const rejected = await handleToken(deps, {
      grant_type: 'refresh_token',
      refresh_token: 'revoked',
    });
    expect(rejected.status).toBe(400);
    expect(rejected.body).toMatchObject({ error: 'invalid_grant' });
  });

  it('rejects unsupported grant types', async () => {
    const deps = makeDeps();
    const result = await handleToken(deps, {
      grant_type: 'client_credentials',
    });
    expect(result.status).toBe(400);
    expect(result.body).toMatchObject({ error: 'unsupported_grant_type' });
  });

  it('re-renders the login on bad credentials without minting a code', async () => {
    const deps = makeDeps(makeAuthGateway(null));
    const clientId = await registerClient(deps);

    const submitted = await handleAuthorizeSubmit(deps, {
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
      response_type: 'code',
      code_challenge: computeS256Challenge('a'.repeat(43)),
      code_challenge_method: 'S256',
      email: 'alice@example.com',
      password: 'wrong',
    });

    expect(submitted.kind).toBe('retry');
  });
});
