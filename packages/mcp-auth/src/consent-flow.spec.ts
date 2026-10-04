import { randomBytes } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import type { AuthSession, IAuthGateway } from './auth-gateway.js';
import {
  handleAuthorizationRead,
  handleAuthorizeStart,
  handleConsentDecision,
  handleRegister,
  handleToken,
  type OAuthDeps,
} from './handlers.js';
import { InMemoryOAuthStore } from './in-memory-oauth-store.js';
import type { AuthorizationDetails, ConsentResult } from './oauth.schema.js';
import { computeS256Challenge } from './pkce.js';

const ISSUER = 'http://localhost:8787';
const WEB_URL = 'http://localhost:3100';
const REDIRECT_URI = 'http://127.0.0.1:41241/callback';
// A second return address of the same client: same machine, another path.
const OTHER_REDIRECT_URI = 'http://127.0.0.1:41241/other';
const ALICE = 'a0000000-0000-4000-8000-00000000000a';
const BOB = 'b0000000-0000-4000-8000-00000000000b';
const CAROL = 'c0000000-0000-4000-8000-00000000000c';
const BEARER = {
  alice: 'Bearer alice-token',
  bob: 'Bearer bob-token',
  // Carol has an authenticator app and signed in without giving its code.
  carol: 'Bearer carol-aal1-token',
};

const sessionOf = (userId: string): AuthSession => ({
  userId,
  accessToken: `agent-access-${randomBytes(4).toString('hex')}`,
  refreshToken: `agent-refresh-${randomBytes(4).toString('hex')}`,
  expiresIn: 3600,
});

/** Two signed-in people, each holding a dashboard token. */
const makeAuthGateway = () =>
  ({
    verifyAccessToken: vi.fn(async (token: string) => {
      if (token === 'alice-token') {
        return { userId: ALICE, owesSecondFactor: false };
      }
      if (token === 'bob-token') {
        return { userId: BOB, owesSecondFactor: false };
      }
      if (token === 'carol-aal1-token') {
        return { userId: CAROL, owesSecondFactor: true };
      }
      return null;
    }),
    mintSession: vi.fn(async (userId: string): Promise<AuthSession | null> =>
      sessionOf(userId)
    ),
    refreshSession: vi.fn().mockResolvedValue(null),
    revokeSession: vi.fn().mockResolvedValue(undefined),
  }) satisfies IAuthGateway;

const setup = async () => {
  const auth = makeAuthGateway();
  const deps: OAuthDeps = {
    store: new InMemoryOAuthStore(),
    auth,
    issuer: ISSUER,
    webUrl: WEB_URL,
  };
  const registered = await handleRegister(deps, {
    client_name: 'zm-unit',
    redirect_uris: [REDIRECT_URI, OTHER_REDIRECT_URI],
  });
  const clientId = (registered.body as { client_id: string }).client_id;
  return { deps, auth, clientId };
};

const authorizeQuery = (
  clientId: string,
  challenge: string,
  redirectUri = REDIRECT_URI
) => ({
  client_id: clientId,
  redirect_uri: redirectUri,
  response_type: 'code',
  code_challenge: challenge,
  code_challenge_method: 'S256',
  state: 'xyz',
});

/** Starts an authorization and returns the id the dashboard receives. */
const start = async (
  deps: OAuthDeps,
  clientId: string,
  challenge = computeS256Challenge(randomBytes(48).toString('base64url')),
  redirectUri = REDIRECT_URI
): Promise<string> => {
  const started = await handleAuthorizeStart(
    deps,
    authorizeQuery(clientId, challenge, redirectUri)
  );
  if (started.kind !== 'redirect') {
    throw new Error(`expected a redirect, got ${started.message}`);
  }
  const location = new URL(started.location);
  expect(location.origin + location.pathname).toBe(`${WEB_URL}/oauth/consent`);
  return location.searchParams.get('authorization_id') ?? '';
};

const redirectOf = (body: unknown): URL =>
  new URL((body as ConsentResult).redirect_url);

describe('registration', () => {
  it('a client returns either to remote hosts or to the local machine, not both', async () => {
    const { deps } = await setup();
    const mixed = await handleRegister(deps, {
      client_name: 'zm-unit-mixed',
      redirect_uris: [REDIRECT_URI, 'https://example.com/cb'],
    });
    expect(mixed.status).toBe(400);
    expect(mixed.body).toHaveProperty('error', 'invalid_redirect_uri');

    const remote = await handleRegister(deps, {
      client_name: 'zm-unit-remote',
      redirect_uris: ['https://example.com/cb', 'https://example.org/cb'],
    });
    expect(remote.status).toBe(201);

    const local = await handleRegister(deps, {
      client_name: 'zm-unit-local',
      redirect_uris: [REDIRECT_URI, 'cursor://anysphere.cursor-mcp/callback'],
    });
    expect(local.status).toBe(201);
  });
});

describe('authorization start', () => {
  it('parks the request and sends the person to the dashboard', async () => {
    const { deps, clientId } = await setup();
    const id = await start(deps, clientId);
    expect(id).toMatch(/^oaa_/);
  });

  it('shows client and redirect problems instead of redirecting', async () => {
    const { deps, clientId } = await setup();
    const started = await handleAuthorizeStart(deps, {
      ...authorizeQuery(clientId, 'a'.repeat(43)),
      redirect_uri: 'http://127.0.0.1:41241/elsewhere',
    });
    expect(started).toMatchObject({ kind: 'invalid', status: 400 });
  });
});

describe('reading an authorization', () => {
  it('requires a signed-in caller', async () => {
    const { deps, clientId } = await setup();
    const id = await start(deps, clientId);
    for (const authorization of [undefined, 'Bearer nope', 'alice-token']) {
      const read = await handleAuthorizationRead(deps, {
        authorizationId: id,
        authorization,
      });
      expect(read.status).toBe(401);
    }
  });

  it('shows the first reader what the client asks for', async () => {
    const { deps, clientId } = await setup();
    const id = await start(deps, clientId);
    const read = await handleAuthorizationRead(deps, {
      authorizationId: id,
      authorization: BEARER.alice,
    });
    expect(read.status).toBe(200);
    expect(read.body as AuthorizationDetails).toMatchObject({
      authorization_id: id,
      client: { client_id: clientId, client_name: 'zm-unit' },
      scope: 'mcp:read mcp:write',
      redirect_uri: REDIRECT_URI,
    });
  });

  it('is nobody else’s once someone opened it', async () => {
    const { deps, clientId } = await setup();
    const id = await start(deps, clientId);
    await handleAuthorizationRead(deps, {
      authorizationId: id,
      authorization: BEARER.alice,
    });
    const read = await handleAuthorizationRead(deps, {
      authorizationId: id,
      authorization: BEARER.bob,
    });
    expect(read.status).toBe(404);
    const decided = await handleConsentDecision(deps, {
      authorizationId: id,
      authorization: BEARER.bob,
      body: { decision: 'approve' },
    });
    expect(decided.status).toBe(404);
  });

  it('answers 404 for an unknown or malformed id', async () => {
    const { deps } = await setup();
    for (const authorizationId of [
      'oaa_0000000000000000.0000000000',
      'not-an-id',
    ]) {
      const read = await handleAuthorizationRead(deps, {
        authorizationId,
        authorization: BEARER.alice,
      });
      expect(read.status).toBe(404);
    }
  });
});

describe('a session that owes its second factor', () => {
  it('can neither read nor decide, and binds nothing', async () => {
    const { deps, auth, clientId } = await setup();
    const id = await start(deps, clientId);
    const read = await handleAuthorizationRead(deps, {
      authorizationId: id,
      authorization: BEARER.carol,
    });
    expect(read.status).toBe(403);
    expect(read.body).toMatchObject({ error: 'insufficient_aal' });
    const decided = await handleConsentDecision(deps, {
      authorizationId: id,
      authorization: BEARER.carol,
      body: { decision: 'approve' },
    });
    expect(decided.status).toBe(403);
    expect(auth.mintSession).not.toHaveBeenCalled();
    // Still waiting for whoever opens it with the code given.
    const alice = await handleAuthorizationRead(deps, {
      authorizationId: id,
      authorization: BEARER.alice,
    });
    expect(alice.status).toBe(200);
  });
});

describe('deciding', () => {
  it('approval issues a code the token endpoint redeems for a fresh session', async () => {
    const { deps, auth, clientId } = await setup();
    const verifier = randomBytes(48).toString('base64url');
    const id = await start(deps, clientId, computeS256Challenge(verifier));
    await handleAuthorizationRead(deps, {
      authorizationId: id,
      authorization: BEARER.alice,
    });
    const decided = await handleConsentDecision(deps, {
      authorizationId: id,
      authorization: BEARER.alice,
      body: { decision: 'approve' },
    });
    expect(decided.status).toBe(200);
    const redirect = redirectOf(decided.body);
    expect(redirect.origin + redirect.pathname).toBe(REDIRECT_URI);
    expect(redirect.searchParams.get('state')).toBe('xyz');
    expect(auth.mintSession).toHaveBeenCalledExactlyOnceWith(ALICE);

    const minted = await vi.mocked(auth.mintSession).mock.results[0]?.value;
    const token = await handleToken(deps, {
      grant_type: 'authorization_code',
      code: redirect.searchParams.get('code'),
      code_verifier: verifier,
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
    });
    expect(token.status).toBe(200);
    expect(token.body).toMatchObject({
      access_token: (minted as AuthSession).accessToken,
      refresh_token: (minted as AuthSession).refreshToken,
    });
  });

  it('a second authorization of an approved client, to the same return address, needs no screen', async () => {
    const { deps, clientId } = await setup();
    const first = await start(deps, clientId);
    await handleConsentDecision(deps, {
      authorizationId: first,
      authorization: BEARER.alice,
      body: { decision: 'approve' },
    });
    // Native clients bind a fresh port per authorization; the address is the
    // same one in every way that matters.
    const second = await start(
      deps,
      clientId,
      undefined,
      REDIRECT_URI.replace(':41241', ':53682')
    );
    const read = await handleAuthorizationRead(deps, {
      authorizationId: second,
      authorization: BEARER.alice,
      screenless: true,
    });
    expect(read.status).toBe(200);
    expect(redirectOf(read.body).searchParams.get('code')).toBeTruthy();
    // Someone else's consent covers nothing for this person.
    const third = await start(deps, clientId);
    const bobRead = await handleAuthorizationRead(deps, {
      authorizationId: third,
      authorization: BEARER.bob,
      screenless: true,
    });
    expect(bobRead.body).toHaveProperty('authorization_id', third);
  });

  it('an arrival sent by another site shows the screen, approved client or not', async () => {
    const { deps, clientId } = await setup();
    const first = await start(deps, clientId);
    await handleConsentDecision(deps, {
      authorizationId: first,
      authorization: BEARER.alice,
      body: { decision: 'approve' },
    });
    // The dashboard says whether the browser arrived on its own, as it does
    // when a client opens the URL; a page elsewhere that sent it here gets
    // the screen, and the person's click, every time.
    const second = await start(deps, clientId);
    const read = await handleAuthorizationRead(deps, {
      authorizationId: second,
      authorization: BEARER.alice,
      screenless: false,
    });
    expect(read.status).toBe(200);
    expect(read.body).toHaveProperty('authorization_id', second);
  });

  it('ends the session it minted when the steps after minting fail', async () => {
    const { deps, auth, clientId } = await setup();
    const id = await start(deps, clientId);
    vi.spyOn(deps.store, 'insertCode').mockRejectedValueOnce(
      new Error('store down')
    );
    await expect(
      handleConsentDecision(deps, {
        authorizationId: id,
        authorization: BEARER.alice,
        body: { decision: 'approve' },
      })
    ).rejects.toThrow('store down');
    // A session nobody will ever use is not left alive.
    expect(auth.revokeSession).toHaveBeenCalledTimes(1);
    expect(auth.revokeSession).toHaveBeenCalledWith(
      expect.objectContaining({ userId: ALICE })
    );
  });

  it('a return address the person has not approved asks again, even for an approved client', async () => {
    const { deps, clientId } = await setup();
    const first = await start(deps, clientId);
    await handleConsentDecision(deps, {
      authorizationId: first,
      authorization: BEARER.alice,
      body: { decision: 'approve' },
    });
    const elsewhere = await start(
      deps,
      clientId,
      undefined,
      OTHER_REDIRECT_URI
    );
    const read = await handleAuthorizationRead(deps, {
      authorizationId: elsewhere,
      authorization: BEARER.alice,
      screenless: true,
    });
    expect(read.status).toBe(200);
    expect(read.body).toMatchObject({
      authorization_id: elsewhere,
      redirect_uri: OTHER_REDIRECT_URI,
    });
    // Approving there is remembered for that address from now on.
    await handleConsentDecision(deps, {
      authorizationId: elsewhere,
      authorization: BEARER.alice,
      body: { decision: 'approve' },
    });
    expect(await deps.store.findConsent(ALICE, clientId)).toMatchObject({
      redirectUri: OTHER_REDIRECT_URI,
    });
  });

  it('a consent recorded before return addresses were kept asks once more', async () => {
    const { deps, clientId } = await setup();
    const first = await start(deps, clientId);
    await handleConsentDecision(deps, {
      authorizationId: first,
      authorization: BEARER.alice,
      body: { decision: 'approve' },
    });
    const recorded = await deps.store.findConsent(ALICE, clientId);
    vi.spyOn(deps.store, 'findConsent').mockResolvedValueOnce({
      scope: recorded?.scope ?? '',
      redirectUri: null,
    });
    const second = await start(deps, clientId);
    const read = await handleAuthorizationRead(deps, {
      authorizationId: second,
      authorization: BEARER.alice,
      screenless: true,
    });
    expect(read.body).toHaveProperty('authorization_id', second);
  });

  it('denial returns access_denied to the client and records no consent', async () => {
    const { deps, auth, clientId } = await setup();
    const id = await start(deps, clientId);
    const decided = await handleConsentDecision(deps, {
      authorizationId: id,
      authorization: BEARER.alice,
      body: { decision: 'deny' },
    });
    expect(decided.status).toBe(200);
    const redirect = redirectOf(decided.body);
    expect(redirect.searchParams.get('error')).toBe('access_denied');
    expect(redirect.searchParams.get('state')).toBe('xyz');
    expect(redirect.searchParams.get('code')).toBeNull();
    expect(auth.mintSession).not.toHaveBeenCalled();
    expect(await deps.store.findConsent(ALICE, clientId)).toBeNull();
  });

  it('is taken once', async () => {
    const { deps, clientId } = await setup();
    const id = await start(deps, clientId);
    const decide = () =>
      handleConsentDecision(deps, {
        authorizationId: id,
        authorization: BEARER.alice,
        body: { decision: 'approve' },
      });
    expect((await decide()).status).toBe(200);
    const again = await decide();
    expect(again.status).toBe(404);
    expect(again.body).not.toHaveProperty('redirect_url');
  });

  it('refuses a malformed decision', async () => {
    const { deps, clientId } = await setup();
    const id = await start(deps, clientId);
    const decided = await handleConsentDecision(deps, {
      authorizationId: id,
      authorization: BEARER.alice,
      body: { decision: 'maybe' },
    });
    expect(decided.status).toBe(400);
  });

  it('reports a session that could not be minted, and issues no code', async () => {
    const { deps, auth, clientId } = await setup();
    vi.mocked(auth.mintSession).mockResolvedValueOnce(null);
    const id = await start(deps, clientId);
    const decided = await handleConsentDecision(deps, {
      authorizationId: id,
      authorization: BEARER.alice,
      body: { decision: 'approve' },
    });
    expect(decided.status).toBe(503);
    expect(decided.body).toMatchObject({ error: 'server_error' });
    expect(await deps.store.findConsent(ALICE, clientId)).toBeNull();
  });
});
