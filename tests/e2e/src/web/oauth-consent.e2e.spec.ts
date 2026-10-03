/**
 * An agent's authorization as the person sees it: the client opens the
 * server's authorize URL in the browser, the dashboard asks them to sign in,
 * shows who is asking and for what, and sends the browser back to the client
 * with a code. The client's loopback listener is a real one, run by the test
 * on the registered port (a reconnect arrives through a chain of redirects,
 * which request interception does not follow), and the test then redeems the
 * code like a real client would.
 *
 * Each test uses its own fresh account, so the consents one test stores never
 * let another skip its screen.
 */
import { createHash, randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';

import {
  expect,
  test,
  type APIRequestContext,
  type Page,
} from '@playwright/test';

import { e2eEnv } from '../helpers/env.js';
import { provisionE2EUser, type E2EUser } from '../helpers/users.js';

const LISTENER_PORT = 45790;
const REDIRECT_URI = `http://127.0.0.1:${LISTENER_PORT}/callback`;

const registerClient = async (
  request: APIRequestContext,
  clientName: string
): Promise<string> => {
  const response = await request.post(`${e2eEnv.serverUrl}/oauth/register`, {
    data: {
      client_name: clientName,
      redirect_uris: [REDIRECT_URI],
      token_endpoint_auth_method: 'none',
    },
  });
  expect(response.status()).toBe(201);
  return (await response.json()).client_id as string;
};

/** A fresh authorization request, as a client would open it. */
const authorizeRequest = (clientId: string) => {
  const verifier = randomBytes(32).toString('base64url');
  const state = randomBytes(8).toString('base64url');
  const url = new URL(`${e2eEnv.serverUrl}/oauth/authorize`);
  url.search = new URLSearchParams({
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    response_type: 'code',
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256',
    state,
  }).toString();
  return { url: url.toString(), verifier, state };
};

/** The client's loopback listener: whatever reaches it is answered with 200. */
const startListener = (): Promise<Server> =>
  new Promise((resolve, reject) => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/plain' });
      response.end('ok');
    });
    server.once('error', reject);
    server.listen(LISTENER_PORT, '127.0.0.1', () => resolve(server));
  });

const signIn = async (page: Page, user: E2EUser) => {
  await page.getByTestId('auth-login-email').fill(user.email);
  await page.getByTestId('auth-login-password').fill(user.password);
  await page.getByTestId('auth-login-submit').click();
};

const freshUser = (label: string, acceptedTerms = true) =>
  provisionE2EUser(`consent-${label}-${Date.now()}@zm.e2e`, { acceptedTerms });

test.describe('agent authorization in the browser', () => {
  let listener: Server | undefined;

  test.beforeAll(async () => {
    listener = await startListener();
  });

  test.afterAll(async () => {
    await new Promise((resolve) => listener?.close(resolve));
  });

  test('@smoke an agent is approved after signing in, then reconnects without a screen', async ({
    page,
    request,
  }) => {
    const user = await freshUser('allow');
    const clientId = await registerClient(request, 'zm-e2e-web');

    const first = authorizeRequest(clientId);
    await page.goto(first.url);
    // A guest: sign-in first, with the consent page as the way back.
    await expect(page).toHaveURL(
      /\/login\?next=%2Foauth%2Fconsent%3Fauthorization_id%3Doaa_/
    );
    await signIn(page, user);

    await expect(page.getByTestId('oauth-consent-client')).toHaveText(
      'zm-e2e-web'
    );
    await expect(page.getByTestId('oauth-consent-return-host')).toHaveText(
      '127.0.0.1'
    );
    await expect(page.getByTestId('oauth-consent-account')).toHaveText(
      user.email
    );
    await page.getByTestId('oauth-consent-allow').click();

    await page.waitForURL((url) => url.href.startsWith(REDIRECT_URI));
    const back = new URL(page.url());
    expect(back.searchParams.get('state')).toBe(first.state);
    const code = back.searchParams.get('code');
    expect(code).toBeTruthy();

    // The client finishes the job: the code buys a working token.
    const token = await request.post(`${e2eEnv.serverUrl}/oauth/token`, {
      form: {
        grant_type: 'authorization_code',
        code: code!,
        code_verifier: first.verifier,
        client_id: clientId,
        redirect_uri: REDIRECT_URI,
      },
    });
    expect(token.status()).toBe(200);

    // Reconnecting the same client: straight back, no screen on the way.
    const second = authorizeRequest(clientId);
    await page.goto(second.url);
    await page.waitForURL((url) => url.href.startsWith(REDIRECT_URI));
    const again = new URL(page.url());
    expect(again.searchParams.get('state')).toBe(second.state);
    expect(again.searchParams.get('code')).toBeTruthy();
  });

  test('@smoke denying sends the client access_denied', async ({
    page,
    request,
  }) => {
    const user = await freshUser('deny');
    const clientId = await registerClient(request, 'zm-e2e-web-deny');

    const { url, state } = authorizeRequest(clientId);
    await page.goto(url);
    await signIn(page, user);
    await page.getByTestId('oauth-consent-deny').click();

    await page.waitForURL((u) => u.href.startsWith(REDIRECT_URI));
    const back = new URL(page.url());
    expect(back.searchParams.get('error')).toBe('access_denied');
    expect(back.searchParams.get('state')).toBe(state);
    expect(back.searchParams.get('code')).toBeNull();
  });

  test('@smoke an account that never accepted the terms accepts them before approving', async ({
    page,
    request,
  }) => {
    // What a sign-up through GitHub or Google leaves behind.
    const user = await freshUser('terms', false);
    const clientId = await registerClient(request, 'zm-e2e-web-terms');

    await page.goto(authorizeRequest(clientId).url);
    await signIn(page, user);
    await expect(page).toHaveURL(
      /\/accept-terms\?next=%2Foauth%2Fconsent%3Fauthorization_id%3Doaa_/
    );
    await page.getByTestId('accept-terms-consent').check();
    await page.getByTestId('accept-terms-submit').click();

    await expect(page.getByTestId('oauth-consent-client')).toHaveText(
      'zm-e2e-web-terms'
    );
  });

  test('@smoke a broken consent link says so instead of failing', async ({
    page,
  }) => {
    const user = await freshUser('broken');
    await page.goto('/oauth/consent?authorization_id=nonsense');
    await signIn(page, user);
    await expect(page.getByTestId('oauth-consent-notice')).toBeVisible();

    await page.goto(
      '/oauth/consent?authorization_id=oaa_0000000000000000.0000000000'
    );
    await expect(page.getByTestId('oauth-consent-notice')).toContainText(
      'expired or was already answered'
    );
  });
});
