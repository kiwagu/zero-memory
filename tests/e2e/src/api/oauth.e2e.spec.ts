/**
 * OAuth surface, protocol level: DCR → authorize → token happy path, the
 * negative cases an attacker would probe (code replay, bad PKCE, wrong
 * credentials, unknown grant), and the fixed-window rate limit.
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

const base = e2eEnv.serverUrl;
const REDIRECT_URI = 'http://127.0.0.1:45789/callback';

const pkcePair = (): { verifier: string; challenge: string } => {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
};

/**
 * A previous run's rate-limit burst may still hold the route's window. Probe
 * with a harmless invalid POST and wait out Retry-After once, so reruns
 * within the window pass instead of flaking on 429.
 */
const awaitRouteCooldown = async (
  request: APIRequestContext,
  path: string
): Promise<void> => {
  const probe = await request.post(`${base}${path}`, { data: {} });
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

interface AuthorizeCodeOptions {
  verifier: string;
  challenge: string;
  clientId: string;
  password?: string;
}

/** Drives GET+POST /oauth/authorize and returns the redirect Location. */
const submitAuthorize = async (
  request: APIRequestContext,
  { challenge, clientId, password }: Omit<AuthorizeCodeOptions, 'verifier'>
) => {
  const state = randomBytes(8).toString('base64url');
  const seed = await readSeedState();
  return {
    state,
    response: await request.post(`${base}/oauth/authorize`, {
      maxRedirects: 0,
      form: {
        client_id: clientId,
        redirect_uri: REDIRECT_URI,
        response_type: 'code',
        code_challenge: challenge,
        code_challenge_method: 'S256',
        state,
        email: seed.userA.email,
        password: password ?? seed.userA.password,
      },
    }),
  };
};

test.describe('OAuth: DCR → authorize → token', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(120_000);

  let clientId = '';

  test.beforeAll(async ({ request }) => {
    await awaitRouteCooldown(request, '/oauth/register');
    await awaitRouteCooldown(request, '/oauth/token');
    await awaitRouteCooldown(request, '/oauth/authorize');
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

  test('@smoke registers a native app with a private-use redirect scheme and drives it end to end', async ({
    request,
  }) => {
    // Cursor and other desktop MCP clients register a custom-scheme deep-link
    // (RFC 8252 §7.1) instead of a loopback URL — PKCE is the interception
    // backstop, so DCR must accept it and the whole flow must round-trip.
    const nativeRedirect = 'cursor://anysphere.cursor-mcp/oauth/callback';
    const register = await request.post(`${base}/oauth/register`, {
      data: {
        client_name: 'zm-e2e-native',
        redirect_uris: [nativeRedirect],
        token_endpoint_auth_method: 'none',
      },
    });
    expect(register.status()).toBe(201);
    const nativeClientId = (await register.json()).client_id as string;

    const { verifier, challenge } = pkcePair();
    const state = randomBytes(8).toString('base64url');
    const seed = await readSeedState();
    const submit = await request.post(`${base}/oauth/authorize`, {
      maxRedirects: 0,
      form: {
        client_id: nativeClientId,
        redirect_uri: nativeRedirect,
        response_type: 'code',
        code_challenge: challenge,
        code_challenge_method: 'S256',
        state,
        email: seed.userA.email,
        password: seed.userA.password,
      },
    });
    expect(submit.status()).toBe(302);
    const location = submit.headers()['location'] ?? '';
    expect(location.startsWith(`${nativeRedirect}?`)).toBe(true);
    const redirected = new URL(location);
    expect(redirected.searchParams.get('state')).toBe(state);
    const code = redirected.searchParams.get('code');
    expect(code).toBeTruthy();

    const token = await request.post(`${base}/oauth/token`, {
      form: {
        grant_type: 'authorization_code',
        code: code!,
        code_verifier: verifier,
        client_id: nativeClientId,
        redirect_uri: nativeRedirect,
      },
    });
    expect(token.status()).toBe(200);
    const mcp = await McpTestClient.connect((await token.json()).access_token);
    try {
      expect(await mcp.listToolNames()).toContain('recall');
    } finally {
      await mcp.close();
    }
  });

  test('@smoke full code+PKCE flow yields a token the MCP endpoint accepts', async ({
    request,
  }) => {
    const { verifier, challenge } = pkcePair();

    const page = await request.get(`${base}/oauth/authorize`, {
      params: {
        client_id: clientId,
        redirect_uri: REDIRECT_URI,
        response_type: 'code',
        code_challenge: challenge,
        code_challenge_method: 'S256',
      },
    });
    expect(page.status()).toBe(200);
    expect(await page.text()).toContain('form');

    const { state, response: submit } = await submitAuthorize(request, {
      challenge,
      clientId,
    });
    expect(submit.status()).toBe(302);
    const location = new URL(submit.headers()['location'] ?? '');
    expect(location.origin + location.pathname).toBe(REDIRECT_URI);
    expect(location.searchParams.get('state')).toBe(state);
    const code = location.searchParams.get('code');
    expect(code).toBeTruthy();

    const token = await request.post(`${base}/oauth/token`, {
      form: {
        grant_type: 'authorization_code',
        code: code!,
        code_verifier: verifier,
        client_id: clientId,
        redirect_uri: REDIRECT_URI,
      },
    });
    expect(token.status()).toBe(200);
    const body = await token.json();
    expect(body.token_type).toBe('bearer');
    expect(body.expires_in).toBeGreaterThan(0);
    expect(typeof body.refresh_token).toBe('string');

    // The issued token must open a real MCP session (end of the chain).
    const mcp = await McpTestClient.connect(body.access_token);
    try {
      expect(await mcp.listToolNames()).toContain('recall');
    } finally {
      await mcp.close();
    }

    // Single-use code: replaying the same redemption must fail.
    const replay = await request.post(`${base}/oauth/token`, {
      form: {
        grant_type: 'authorization_code',
        code: code!,
        code_verifier: verifier,
        client_id: clientId,
        redirect_uri: REDIRECT_URI,
      },
    });
    expect(replay.status()).toBe(400);
    expect((await replay.json()).error).toBe('invalid_grant');
  });

  test('@smoke rejects a wrong PKCE verifier', async ({ request }) => {
    const { challenge } = pkcePair();
    const { response: submit } = await submitAuthorize(request, {
      challenge,
      clientId,
    });
    expect(submit.status()).toBe(302);
    const code = new URL(submit.headers()['location'] ?? '').searchParams.get(
      'code'
    );

    const token = await request.post(`${base}/oauth/token`, {
      form: {
        grant_type: 'authorization_code',
        code: code!,
        code_verifier: randomBytes(32).toString('base64url'),
        client_id: clientId,
        redirect_uri: REDIRECT_URI,
      },
    });
    expect(token.status()).toBe(400);
    expect((await token.json()).error).toBe('invalid_grant');
  });

  test('@smoke rejects wrong credentials with a retry page, not a redirect', async ({
    request,
  }) => {
    const { challenge } = pkcePair();
    const { response } = await submitAuthorize(request, {
      challenge,
      clientId,
      password: 'definitely-wrong-password',
    });
    expect(response.status()).toBe(401);
    expect(await response.text()).toContain('Invalid email or password');
  });

  test('@smoke rejects unknown grant types', async ({ request }) => {
    const response = await request.post(`${base}/oauth/token`, {
      form: { grant_type: 'client_credentials' },
    });
    expect(response.status()).toBe(400);
    expect((await response.json()).error).toBe('unsupported_grant_type');
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
