/**
 * OAuth surface, protocol level: DCR, the hand-off from /oauth/authorize to the
 * dashboard's consent screen, the consent API the screen talks to, code + PKCE
 * redemption, and the negative cases an attacker would probe (a request opened
 * by someone else, code replay, bad PKCE, unknown grant), plus the
 * fixed-window rate limit.
 *
 * The consent API is driven here with the person's dashboard session from a
 * password grant; the browser half of the same flow is the web spec.
 *
 * The specs run in file order in one worker (fullyParallel: false). The
 * rate-limit burst is the LAST test on purpose: it exhausts the /oauth/token
 * window for up to a minute, and `awaitRouteCooldown` at suite start makes an
 * immediate rerun deterministic instead of flaky.
 */
import { createHash, randomBytes } from 'node:crypto';

import { expect, test, type APIRequestContext } from '@playwright/test';

import { e2eEnv } from '../helpers/env.js';
import { McpTestClient } from '../helpers/mcp.js';
import { readSeedState } from '../helpers/runtime-state.js';
import { passwordGrantToken } from '../helpers/users.js';

const base = e2eEnv.serverUrl;
const REDIRECT_URI = 'http://127.0.0.1:45789/callback';

const pkcePair = (): { verifier: string; challenge: string } => {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
};

/**
 * A previous run's rate-limit burst may still hold the route's window. Probe
 * with a harmless invalid request and wait out Retry-After once, so reruns
 * within the window pass instead of flaking on 429.
 */
const awaitRouteCooldown = async (
  request: APIRequestContext,
  path: string,
  method: 'get' | 'post' = 'post'
): Promise<void> => {
  const probe =
    method === 'get'
      ? await request.get(`${base}${path}`, { maxRedirects: 0 })
      : await request.post(`${base}${path}`, { data: {} });
  if (probe.status() === 429) {
    const retryAfter = Number.parseInt(
      probe.headers()['retry-after'] ?? '60',
      10
    );
    await new Promise((resolve) =>
      setTimeout(resolve, (retryAfter + 1) * 1000)
    );
  }
};

const registerClient = async (
  request: APIRequestContext,
  clientName: string,
  redirectUri = REDIRECT_URI
): Promise<string> => {
  const response = await request.post(`${base}/oauth/register`, {
    data: {
      client_name: clientName,
      redirect_uris: [redirectUri],
      token_endpoint_auth_method: 'none',
    },
  });
  expect(response.status()).toBe(201);
  return (await response.json()).client_id as string;
};

/**
 * GET /oauth/authorize, the browser's first stop: answered with a hand-off to
 * the dashboard's consent page carrying only the parked request's id.
 */
const startAuthorization = async (
  request: APIRequestContext,
  clientId: string,
  challenge: string,
  redirectUri = REDIRECT_URI
): Promise<{ state: string; authorizationId: string }> => {
  const state = randomBytes(8).toString('base64url');
  const response = await request.get(`${base}/oauth/authorize`, {
    maxRedirects: 0,
    params: {
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state,
    },
  });
  expect(response.status()).toBe(302);
  const location = new URL(response.headers()['location'] ?? '');
  expect(location.origin + location.pathname).toBe(
    `${e2eEnv.webUrl}/oauth/consent`
  );
  expect([...location.searchParams.keys()]).toEqual(['authorization_id']);
  const authorizationId = location.searchParams.get('authorization_id') ?? '';
  expect(authorizationId).toMatch(/^oaa_/);
  return { state, authorizationId };
};

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

const readAuthorization = (
  request: APIRequestContext,
  token: string,
  authorizationId: string
) =>
  request.get(`${base}/oauth/authorizations/${authorizationId}`, {
    headers: bearer(token),
  });

const decide = (
  request: APIRequestContext,
  token: string,
  authorizationId: string,
  decision: 'approve' | 'deny'
) =>
  request.post(`${base}/oauth/authorizations/${authorizationId}/consent`, {
    headers: bearer(token),
    data: { decision },
  });

/** The client's redirect URI as the consent API returned it. */
const redirectOf = async (response: {
  json(): Promise<unknown>;
}): Promise<URL> =>
  new URL(((await response.json()) as { redirect_url: string }).redirect_url);

const redeem = (
  request: APIRequestContext,
  {
    code,
    verifier,
    clientId,
    redirectUri = REDIRECT_URI,
  }: {
    code: string;
    verifier: string;
    clientId: string;
    redirectUri?: string;
  }
) =>
  request.post(`${base}/oauth/token`, {
    form: {
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier,
      client_id: clientId,
      redirect_uri: redirectUri,
    },
  });

/** The agent's JWT claims, read without verification (the server did that). */
const claimsOf = (accessToken: string): Record<string, unknown> =>
  JSON.parse(
    Buffer.from(accessToken.split('.')[1] ?? '', 'base64url').toString('utf8')
  ) as Record<string, unknown>;

test.describe('OAuth: DCR → dashboard consent → token', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(120_000);

  let clientId = '';
  let tokenA = '';
  let tokenB = '';

  test.beforeAll(async ({ request }) => {
    await awaitRouteCooldown(request, '/oauth/register');
    await awaitRouteCooldown(request, '/oauth/token');
    await awaitRouteCooldown(request, '/oauth/authorize', 'get');
    const seed = await readSeedState();
    tokenA = await passwordGrantToken(seed.userA);
    tokenB = await passwordGrantToken(seed.userB);
  });

  test('@smoke advertises RFC 8414 metadata', async ({ request }) => {
    const response = await request.get(
      `${base}/.well-known/oauth-authorization-server`
    );
    expect(response.status()).toBe(200);
    const body = await response.json();
    expect(body.registration_endpoint).toContain('/oauth/register');
    expect(body.code_challenge_methods_supported).toContain('S256');
  });

  test('@smoke DCR registers a public loopback client', async ({ request }) => {
    const response = await request.post(`${base}/oauth/register`, {
      data: {
        client_name: 'zm-e2e',
        redirect_uris: [REDIRECT_URI],
        token_endpoint_auth_method: 'none',
      },
    });
    expect(response.status()).toBe(201);
    const body = await response.json();
    expect(typeof body.client_id).toBe('string');
    expect(body.redirect_uris).toEqual([REDIRECT_URI]);
    clientId = body.client_id;
  });

  test('@smoke authorize hands the browser to the dashboard', async ({
    request,
  }) => {
    const { challenge } = pkcePair();
    // The assertions live in the helper: a 302 to the consent page that
    // carries the parked request's id and nothing else.
    await startAuthorization(request, clientId, challenge);
  });

  test('@smoke a request with an unregistered redirect is shown, never followed', async ({
    request,
  }) => {
    const { challenge } = pkcePair();
    const response = await request.get(`${base}/oauth/authorize`, {
      maxRedirects: 0,
      params: {
        client_id: clientId,
        redirect_uri: 'http://127.0.0.1:45789/elsewhere',
        response_type: 'code',
        code_challenge: challenge,
        code_challenge_method: 'S256',
      },
    });
    expect(response.status()).toBe(400);
    expect(response.headers()['location']).toBeUndefined();
    expect(await response.text()).toContain('redirect_uri is not registered');
  });

  test('@smoke consent issues a code the token endpoint redeems', async ({
    request,
  }) => {
    const { verifier, challenge } = pkcePair();
    const { state, authorizationId } = await startAuthorization(
      request,
      clientId,
      challenge
    );

    const read = await readAuthorization(request, tokenA, authorizationId);
    expect(read.status()).toBe(200);
    const details = await read.json();
    expect(details).toMatchObject({
      authorization_id: authorizationId,
      client: { client_id: clientId, client_name: 'zm-e2e' },
      scope: 'mcp:read mcp:write',
      redirect_uri: REDIRECT_URI,
    });

    const decided = await decide(request, tokenA, authorizationId, 'approve');
    expect(decided.status()).toBe(200);
    const location = await redirectOf(decided);
    expect(location.origin + location.pathname).toBe(REDIRECT_URI);
    expect(location.searchParams.get('state')).toBe(state);
    const code = location.searchParams.get('code');
    expect(code).toBeTruthy();

    const token = await redeem(request, { code: code!, verifier, clientId });
    expect(token.status()).toBe(200);
    const body = await token.json();
    expect(body.token_type).toBe('bearer');
    expect(body.expires_in).toBeGreaterThan(0);
    expect(typeof body.refresh_token).toBe('string');

    // The agent got a session of its own, not the dashboard's: same person,
    // another session, opened by a one-time sign-in rather than a password.
    const agent = claimsOf(body.access_token);
    const browser = claimsOf(tokenA);
    expect(agent.sub).toBe(browser.sub);
    expect(agent.session_id).not.toBe(browser.session_id);
    expect(JSON.stringify(agent.amr)).not.toContain('password');

    // The issued token must open a real MCP session (end of the chain).
    const mcp = await McpTestClient.connect(body.access_token);
    try {
      expect(await mcp.listToolNames()).toContain('recall');
    } finally {
      await mcp.close();
    }

    // Single-use code: replaying the same redemption must fail.
    const replay = await redeem(request, { code: code!, verifier, clientId });
    expect(replay.status()).toBe(400);
    expect((await replay.json()).error).toBe('invalid_grant');

    // And the decision itself is taken once.
    const again = await decide(request, tokenA, authorizationId, 'approve');
    expect(again.status()).toBe(404);
  });

  test('@smoke a second authorization of the same client is approved without a screen', async ({
    request,
  }) => {
    const { verifier, challenge } = pkcePair();
    const { state, authorizationId } = await startAuthorization(
      request,
      clientId,
      challenge
    );
    const read = await readAuthorization(request, tokenA, authorizationId);
    expect(read.status()).toBe(200);
    const location = await redirectOf(read);
    expect(location.searchParams.get('state')).toBe(state);
    const token = await redeem(request, {
      code: location.searchParams.get('code')!,
      verifier,
      clientId,
    });
    expect(token.status()).toBe(200);
  });

  test('@smoke a request binds to the first person who opens it', async ({
    request,
  }) => {
    const bindingClient = await registerClient(request, 'zm-e2e-binding');
    const { challenge } = pkcePair();
    const { authorizationId } = await startAuthorization(
      request,
      bindingClient,
      challenge
    );
    expect(
      (await readAuthorization(request, tokenA, authorizationId)).status()
    ).toBe(200);
    // A second person — say, whoever a "please approve" link was forwarded
    // to — can neither see it nor decide it.
    expect(
      (await readAuthorization(request, tokenB, authorizationId)).status()
    ).toBe(404);
    expect(
      (await decide(request, tokenB, authorizationId, 'approve')).status()
    ).toBe(404);
    // It is still waiting for the person it belongs to.
    expect(
      (await readAuthorization(request, tokenA, authorizationId)).status()
    ).toBe(200);
  });

  test('@smoke deny returns access_denied to the client', async ({
    request,
  }) => {
    const denyClient = await registerClient(request, 'zm-e2e-deny');
    const { challenge } = pkcePair();
    const { state, authorizationId } = await startAuthorization(
      request,
      denyClient,
      challenge
    );
    const decided = await decide(request, tokenA, authorizationId, 'deny');
    expect(decided.status()).toBe(200);
    const location = await redirectOf(decided);
    expect(location.origin + location.pathname).toBe(REDIRECT_URI);
    expect(location.searchParams.get('error')).toBe('access_denied');
    expect(location.searchParams.get('state')).toBe(state);
    expect(location.searchParams.get('code')).toBeNull();

    // A denial is not remembered: the next request asks again.
    const next = await startAuthorization(request, denyClient, challenge);
    const read = await readAuthorization(request, tokenA, next.authorizationId);
    expect(await read.json()).toHaveProperty(
      'authorization_id',
      next.authorizationId
    );
  });

  test('@smoke an unknown id is 404 and a guest is 401', async ({
    request,
  }) => {
    for (const id of ['oaa_0000000000000000.0000000000', 'not-an-id']) {
      expect((await readAuthorization(request, tokenA, id)).status()).toBe(404);
    }
    const { challenge } = pkcePair();
    const { authorizationId } = await startAuthorization(
      request,
      clientId,
      challenge
    );
    const guest = await request.get(
      `${base}/oauth/authorizations/${authorizationId}`
    );
    expect(guest.status()).toBe(401);
    expect(
      (
        await request.post(
          `${base}/oauth/authorizations/${authorizationId}/consent`,
          { data: { decision: 'approve' } }
        )
      ).status()
    ).toBe(401);
  });

  test('@smoke the agent session survives the browser signing out', async ({
    request,
  }) => {
    // A dashboard session of its own for this test, so signing it out does
    // not disturb the others.
    const seed = await readSeedState();
    const browserToken = await passwordGrantToken(seed.userA);
    const { verifier, challenge } = pkcePair();
    const { authorizationId } = await startAuthorization(
      request,
      clientId,
      challenge
    );
    const read = await readAuthorization(
      request,
      browserToken,
      authorizationId
    );
    const location = await redirectOf(read);
    const token = await redeem(request, {
      code: location.searchParams.get('code')!,
      verifier,
      clientId,
    });
    const agent = await token.json();

    const logout = await request.post(
      `${e2eEnv.supabaseUrl}/auth/v1/logout?scope=local`,
      {
        headers: {
          apikey: e2eEnv.supabaseAnonKey,
          authorization: `Bearer ${browserToken}`,
        },
      }
    );
    expect(logout.status()).toBe(204);

    const refreshed = await request.post(`${base}/oauth/token`, {
      form: { grant_type: 'refresh_token', refresh_token: agent.refresh_token },
    });
    expect(refreshed.status()).toBe(200);
    const mcp = await McpTestClient.connect(
      (await refreshed.json()).access_token
    );
    try {
      expect(await mcp.listToolNames()).toContain('recall');
    } finally {
      await mcp.close();
    }
  });

  test('@smoke registers a native app with a private-use redirect scheme and drives it end to end', async ({
    request,
  }) => {
    // Cursor and other desktop MCP clients register a custom-scheme deep-link
    // (RFC 8252 §7.1) instead of a loopback URL — PKCE is the interception
    // backstop, so DCR must accept it and the whole flow must round-trip.
    const nativeRedirect = 'cursor://anysphere.cursor-mcp/oauth/callback';
    const nativeClientId = await registerClient(
      request,
      'zm-e2e-native',
      nativeRedirect
    );
    const { verifier, challenge } = pkcePair();
    const { state, authorizationId } = await startAuthorization(
      request,
      nativeClientId,
      challenge,
      nativeRedirect
    );
    const decided = await decide(request, tokenA, authorizationId, 'approve');
    expect(decided.status()).toBe(200);
    const location = await redirectOf(decided);
    expect(location.href.startsWith(`${nativeRedirect}?`)).toBe(true);
    expect(location.searchParams.get('state')).toBe(state);

    const token = await redeem(request, {
      code: location.searchParams.get('code')!,
      verifier,
      clientId: nativeClientId,
      redirectUri: nativeRedirect,
    });
    expect(token.status()).toBe(200);
    const mcp = await McpTestClient.connect((await token.json()).access_token);
    try {
      expect(await mcp.listToolNames()).toContain('recall');
    } finally {
      await mcp.close();
    }
  });

  test('@smoke rejects a wrong PKCE verifier', async ({ request }) => {
    const { challenge } = pkcePair();
    const { authorizationId } = await startAuthorization(
      request,
      clientId,
      challenge
    );
    const read = await readAuthorization(request, tokenA, authorizationId);
    const code = (await redirectOf(read)).searchParams.get('code');

    const token = await redeem(request, {
      code: code!,
      verifier: randomBytes(32).toString('base64url'),
      clientId,
    });
    expect(token.status()).toBe(400);
    expect((await token.json()).error).toBe('invalid_grant');
  });

  test('@smoke rate-limits token brute force with 429 + Retry-After', async ({
    request,
  }) => {
    let limited = null;
    for (let i = 0; i < e2eEnv.rateLimitMax * 2 + 5; i += 1) {
      const response = await request.post(`${base}/oauth/token`, {
        form: { grant_type: 'authorization_code', code: 'bogus' },
      });
      if (response.status() === 429) {
        limited = response;
        break;
      }
      expect(response.status()).toBe(400);
    }
    expect(limited, 'burst never hit the rate limit').not.toBeNull();
    expect(
      Number.parseInt(limited!.headers()['retry-after'] ?? '0', 10)
    ).toBeGreaterThan(0);
    expect((await limited!.json()).error).toBe('rate_limited');
  });
});
