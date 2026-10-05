/**
 * Connected agents in Settings: every client the person approved is listed
 * with the return address it was approved for, and revoking one takes its
 * access back at once — the memory server and the database refuse the token
 * it holds, its refresh fails, and connecting it again asks for consent.
 * Also: a person's own session that ended elsewhere is sent to sign in
 * instead of being shown an empty dashboard.
 *
 * Each test uses its own fresh account. The client's loopback listener runs
 * on its own port, apart from the consent spec's.
 */
import type { Server } from 'node:http';

import { createClient } from '@supabase/supabase-js';
import { expect, test, type Page } from '@playwright/test';

import { e2eEnv } from '../helpers/env.js';
import {
  authorizeRequest,
  awaitRouteCooldown,
  loopbackRedirectUri,
  registerClient,
  startLoopbackListener,
} from '../helpers/oauth-client.js';
import { dashboardSessionCookies } from '../helpers/session-cookie.js';
import {
  provisionE2EUser,
  userRestClient,
  type E2EUser,
} from '../helpers/users.js';

const LISTENER_PORT = 45791;
const FIRST_ADDRESS = loopbackRedirectUri(LISTENER_PORT);
const SECOND_ADDRESS = `http://127.0.0.1:${LISTENER_PORT}/second`;

const admin = () =>
  createClient(e2eEnv.supabaseUrl, e2eEnv.supabaseServiceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

const freshUser = (label: string) =>
  provisionE2EUser(`agents-${label}-${Date.now()}@zm.e2e`);

const signIn = async (page: Page, user: E2EUser) => {
  await page.getByTestId('auth-login-email').fill(user.email);
  await page.getByTestId('auth-login-password').fill(user.password);
  await page.getByTestId('auth-login-submit').click();
};

/**
 * Opens the client's authorization request and approves it on the consent
 * screen, signing in on the way when `user` is given; returns the code the
 * client got back with the verifier that redeems it.
 */
const approve = async (
  page: Page,
  clientId: string,
  address: string,
  user?: E2EUser
) => {
  const request = authorizeRequest(clientId, address);
  await page.goto(request.url);
  if (user) {
    await signIn(page, user);
  }
  await page.getByTestId('oauth-consent-allow').click();
  await page.waitForURL((url) => url.href.startsWith(address));
  const code = new URL(page.url()).searchParams.get('code');
  expect(code).toBeTruthy();
  return { code: code!, verifier: request.verifier };
};

/** The first request of an MCP session, sent by hand to read the status. */
const mcpInitialize = (accessToken: string) =>
  fetch(`${e2eEnv.serverUrl}/mcp`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${accessToken}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'zm-e2e-connected-agents', version: '0.1.0' },
      },
    }),
  });

test.describe('connected agents', () => {
  let listener: Server | undefined;

  test.beforeAll(async ({ request }) => {
    // The API spec's rate-limit burst may still hold the token route's
    // window; start in a fresh one.
    test.setTimeout(90_000);
    await awaitRouteCooldown(request, '/oauth/register');
    await awaitRouteCooldown(request, '/oauth/token');
    listener = await startLoopbackListener(LISTENER_PORT);
  });

  test.afterAll(async () => {
    await new Promise((resolve) => listener?.close(resolve));
  });

  test('@smoke approved agents are listed one per client, and a revoked one loses access at once', async ({
    page,
    request,
  }) => {
    const user = await freshUser('revoke');
    // Two installs of the same agent: same name, different return address.
    const first = await registerClient(request, 'zm-e2e-agent', FIRST_ADDRESS);
    const second = await registerClient(
      request,
      'zm-e2e-agent',
      SECOND_ADDRESS
    );

    // The first approval signs the person in on the way, and the client
    // redeems its code like a real one.
    const firstGrant = await approve(page, first, FIRST_ADDRESS, user);
    const tokenResponse = await request.post(
      `${e2eEnv.serverUrl}/oauth/token`,
      {
        form: {
          grant_type: 'authorization_code',
          code: firstGrant.code,
          code_verifier: firstGrant.verifier,
          client_id: first,
          redirect_uri: FIRST_ADDRESS,
        },
      }
    );
    expect(tokenResponse.status()).toBe(200);
    const tokens = (await tokenResponse.json()) as {
      access_token: string;
      refresh_token: string;
    };
    expect((await mcpInitialize(tokens.access_token)).status).toBe(200);

    await approve(page, second, SECOND_ADDRESS);

    // Both are listed, as two rows told apart by their return address.
    await page.goto('/settings');
    const rows = page.getByTestId('connected-agent');
    await expect(rows).toHaveCount(2);
    const firstRow = page.locator(
      `[data-testid="connected-agent"][data-client-id="${first}"]`
    );
    const secondRow = page.locator(
      `[data-testid="connected-agent"][data-client-id="${second}"]`
    );
    await expect(firstRow.getByTestId('connected-agent-name')).toHaveText(
      'zm-e2e-agent'
    );
    await expect(secondRow.getByTestId('connected-agent-name')).toHaveText(
      'zm-e2e-agent'
    );
    await expect(firstRow.getByTestId('connected-agent-address')).toContainText(
      FIRST_ADDRESS
    );
    await expect(
      secondRow.getByTestId('connected-agent-address')
    ).toContainText(SECOND_ADDRESS);
    await expect(
      firstRow.getByTestId('connected-agent-last-used')
    ).toContainText('UTC');

    // Revoke the first, after the confirmation.
    await firstRow.getByTestId('connected-agent-revoke').click();
    await expect(page.getByTestId('connected-agent-dialog')).toContainText(
      'zm-e2e-agent'
    );
    await page.getByTestId('connected-agent-confirm').click();
    await expect(firstRow).toHaveCount(0);
    await expect(secondRow).toHaveCount(1);

    // The token the agent holds has not expired, and still reaches nothing.
    expect((await mcpInitialize(tokens.access_token)).status).toBe(401);
    const { data: profile } = await userRestClient(tokens.access_token)
      .from('profiles')
      .select('id')
      .eq('user_id', user.id);
    expect(profile).toEqual([]);
    // Nor can it buy a new one.
    const refreshed = await request.post(`${e2eEnv.serverUrl}/oauth/token`, {
      form: {
        grant_type: 'refresh_token',
        refresh_token: tokens.refresh_token,
        client_id: first,
      },
    });
    expect(refreshed.status()).not.toBe(200);

    // Connecting it again asks for consent once more.
    await page.goto(authorizeRequest(first, FIRST_ADDRESS).url);
    await expect(page.getByTestId('oauth-consent-client')).toHaveText(
      'zm-e2e-agent'
    );
  });

  test('@smoke an agent cannot list or revoke agents through the database', async ({
    page,
    request,
  }) => {
    const user = await freshUser('no-api');
    const clientId = await registerClient(
      request,
      'zm-e2e-agent-api',
      FIRST_ADDRESS
    );
    const grant = await approve(page, clientId, FIRST_ADDRESS, user);
    const tokens = (await (
      await request.post(`${e2eEnv.serverUrl}/oauth/token`, {
        form: {
          grant_type: 'authorization_code',
          code: grant.code,
          code_verifier: grant.verifier,
          client_id: clientId,
          redirect_uri: FIRST_ADDRESS,
        },
      })
    ).json()) as { access_token: string };

    const { data: profiles } = await admin()
      .from('profiles')
      .select('id')
      .eq('user_id', user.id)
      .single();
    const rest = userRestClient(tokens.access_token);
    const listed = await rest.rpc('connected_agents', {
      p_user_id: profiles?.id,
    });
    expect(listed.error?.code).toBe('42501');
    const revoked = await rest.rpc('revoke_connected_agent', {
      p_user_id: profiles?.id,
      p_client_id: clientId,
    });
    expect(revoked.error?.code).toBe('42501');
    // And it still works: nothing was revoked.
    expect((await mcpInitialize(tokens.access_token)).status).toBe(200);
  });

  test('@smoke a session that ended elsewhere is sent to sign in, not shown an empty dashboard', async ({
    page,
    context,
  }) => {
    const user = await freshUser('ended');
    const anon = createClient(e2eEnv.supabaseUrl, e2eEnv.supabaseAnonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data, error } = await anon.auth.signInWithPassword({
      email: user.email,
      password: user.password,
    });
    if (error || !data.session) {
      throw new Error(`sign-in failed: ${error?.message}`);
    }
    await context.addCookies(dashboardSessionCookies(data.session));
    await page.goto('/settings');
    await expect(page.getByTestId('settings-connected-agents')).toBeVisible();
    await expect(page.getByTestId('connected-agents-empty')).toBeVisible();

    // Ended on the server, as a sign-out elsewhere or a password change does;
    // the token in the cookie has not expired.
    const { error: signOutError } = await admin().auth.admin.signOut(
      data.session.access_token,
      'local'
    );
    expect(signOutError).toBeNull();

    await page.goto('/settings');
    await expect(page).toHaveURL(/\/login\?next=%2Fsettings$/);
    await expect(page.getByTestId('auth-login-email')).toBeVisible();
  });
});
