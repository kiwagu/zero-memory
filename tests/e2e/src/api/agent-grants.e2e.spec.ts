/**
 * An agent's grant outlives the person's own sign-ins. Giving the second
 * factor makes Auth delete every weaker session of the account, the agent's
 * included; the authorization server opens a new one at the agent's next
 * refresh, so the agent never notices. What still ends an agent is what a
 * person means to shut it out with — a changed password — and a refresh
 * token that was already replaced coming back, which only a copy would do.
 *
 * Each test uses an account of its own: giving the code on one account ends
 * that account's sessions and nobody else's.
 */
import { createClient } from '@supabase/supabase-js';
import { expect, test, type APIRequestContext } from '@playwright/test';

import { e2eEnv } from '../helpers/env.js';
import { McpTestClient } from '../helpers/mcp.js';
import { enrollTotp, verifyTotp } from '../helpers/mfa.js';
import {
  awaitRouteCooldown,
  decide,
  pkcePair,
  readAuthorization,
  redeem,
  redirectOf,
  registerClient,
  startAuthorization,
} from '../helpers/oauth-client.js';
import { passwordGrantToken, provisionE2EUser } from '../helpers/users.js';

// The consent API answers with the redirect; nothing has to listen there.
const REDIRECT_URI = 'http://127.0.0.1:45796/callback';

interface AgentTokens {
  access_token: string;
  refresh_token: string;
}

const admin = () =>
  createClient(e2eEnv.supabaseUrl, e2eEnv.supabaseServiceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

const freshUser = (label: string) =>
  provisionE2EUser(`grant-${label}-${Date.now()}@zm.e2e`);

/** The person approves the client on the consent screen; the client redeems. */
const connectAgent = async (
  request: APIRequestContext,
  personToken: string,
  clientId: string
): Promise<AgentTokens> => {
  const { verifier, challenge } = pkcePair();
  const { authorizationId } = await startAuthorization(
    request,
    clientId,
    challenge,
    REDIRECT_URI
  );
  expect(
    (await readAuthorization(request, personToken, authorizationId)).status()
  ).toBe(200);
  const decided = await decide(
    request,
    personToken,
    authorizationId,
    'approve'
  );
  expect(decided.status()).toBe(200);
  const code = (await redirectOf(decided)).searchParams.get('code') ?? '';
  const token = await redeem(request, {
    code,
    verifier,
    clientId,
    redirectUri: REDIRECT_URI,
  });
  expect(token.status()).toBe(200);
  return (await token.json()) as AgentTokens;
};

const refresh = (
  request: APIRequestContext,
  refreshToken: string,
  clientId: string
) =>
  request.post(`${e2eEnv.serverUrl}/oauth/token`, {
    form: {
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: clientId,
    },
  });

/** Whether the memory server takes this access token. */
const reachesMemory = async (accessToken: string): Promise<boolean> => {
  try {
    const mcp = await McpTestClient.connect(accessToken);
    try {
      return (await mcp.listToolNames()).includes('recall');
    } finally {
      await mcp.close();
    }
  } catch {
    return false;
  }
};

test.describe("an agent's grant", () => {
  test.setTimeout(120_000);

  test.beforeAll(async ({ request }) => {
    test.setTimeout(240_000);
    await awaitRouteCooldown(request, '/oauth/register');
    await awaitRouteCooldown(request, '/oauth/token');
    await awaitRouteCooldown(request, '/oauth/authorize', 'get');
  });

  test('@smoke the agent keeps working after the person gives the code', async ({
    request,
  }) => {
    const user = await freshUser('code');
    const enrolled = await enrollTotp(await passwordGrantToken(user));
    const clientId = await registerClient(
      request,
      'zm-e2e-grant-code',
      REDIRECT_URI
    );
    const agent = await connectAgent(
      request,
      enrolled.aal2AccessToken,
      clientId
    );
    expect(await reachesMemory(agent.access_token)).toBe(true);

    // The person signs in again and gives the code: Auth deletes every
    // session of the account below that level, the agent's included.
    await verifyTotp(
      await passwordGrantToken(user),
      enrolled.factorId,
      enrolled.secret,
      enrolled.lastCode
    );
    expect(await reachesMemory(agent.access_token)).toBe(false);

    // The agent's next refresh is answered with a session of its own again.
    const refreshed = await refresh(request, agent.refresh_token, clientId);
    expect(refreshed.status()).toBe(200);
    const renewed = (await refreshed.json()) as AgentTokens;
    expect(renewed.refresh_token).not.toBe(agent.refresh_token);
    expect(await reachesMemory(renewed.access_token)).toBe(true);
  });

  test('@smoke a password change still ends the agent', async ({ request }) => {
    const user = await freshUser('password');
    const clientId = await registerClient(
      request,
      'zm-e2e-grant-password',
      REDIRECT_URI
    );
    const agent = await connectAgent(
      request,
      await passwordGrantToken(user),
      clientId
    );

    const { error } = await admin().auth.admin.updateUserById(user.id, {
      password: `${user.password}-changed`,
    });
    expect(error).toBeNull();

    const refused = await refresh(request, agent.refresh_token, clientId);
    expect(refused.status()).toBe(400);
    expect(await refused.json()).toMatchObject({ error: 'invalid_grant' });
  });

  test('@smoke a refresh token that was already replaced ends the grant', async ({
    request,
  }) => {
    const user = await freshUser('replay');
    const clientId = await registerClient(
      request,
      'zm-e2e-grant-replay',
      REDIRECT_URI
    );
    const first = await connectAgent(
      request,
      await passwordGrantToken(user),
      clientId
    );
    const second = (await (
      await refresh(request, first.refresh_token, clientId)
    ).json()) as AgentTokens;
    const third = await refresh(request, second.refresh_token, clientId);
    expect(third.status()).toBe(200);
    const latest = (await third.json()) as AgentTokens;

    // Two generations back: only a copy would still hold it.
    expect(
      (await refresh(request, first.refresh_token, clientId)).status()
    ).toBe(400);
    // The grant ended with it, so the latest token is refused as well.
    expect(
      (await refresh(request, latest.refresh_token, clientId)).status()
    ).toBe(400);
  });
});
