/**
 * Two-factor authentication as a person meets it: turning an authenticator
 * app on in Settings, the code step after every sign-in, the consent screen
 * and account deletion behind it, and the ways out that must not leave a
 * half-enrolled factor behind. Codes are computed from the enrolment secret
 * the way a phone would; each test uses its own fresh account.
 */
import { createHash, randomBytes } from 'node:crypto';

import { createClient } from '@supabase/supabase-js';
import { expect, test, type Page } from '@playwright/test';

import { e2eEnv } from '../helpers/env.js';
import { enrollTotp, totpCode } from '../helpers/mfa.js';
import {
  passwordGrantToken,
  provisionE2EUser,
  type E2EUser,
} from '../helpers/users.js';

const admin = () =>
  createClient(e2eEnv.supabaseUrl, e2eEnv.supabaseServiceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

const freshUser = (label: string) =>
  provisionE2EUser(`mfa-${label}-${Date.now()}@zm.e2e`);

/** A user with an authenticator app already on, and the code it last used. */
const userWithFactor = async (label: string) => {
  const user = await freshUser(label);
  const enrolled = await enrollTotp(await passwordGrantToken(user));
  return { user, secret: enrolled.secret, lastCode: enrolled.lastCode };
};

const signIn = async (page: Page, user: E2EUser, path = '/login') => {
  await page.goto(path);
  await page.getByTestId('auth-login-email').fill(user.email);
  await page.getByTestId('auth-login-password').fill(user.password);
  await page.getByTestId('auth-login-submit').click();
};

/** Gives the code on the step page; returns the code it used. */
const giveCode = async (
  page: Page,
  secret: string,
  notThis?: string
): Promise<string> => {
  const code = await totpCode(secret, notThis);
  await page.getByTestId('mfa-verify-code').fill(code);
  await page.getByTestId('mfa-verify-submit').click();
  return code;
};

const verifiedFactors = async (userId: string): Promise<number> => {
  const { data } = await admin().auth.admin.mfa.listFactors({ userId });
  return (data?.factors ?? []).filter((factor) => factor.status === 'verified')
    .length;
};

test.describe('two-factor authentication', () => {
  // A code is accepted once, so a second one waits for the next 30-second
  // window of the authenticator; give each test room for two such waits.
  test.setTimeout(120_000);

  test('@smoke no factor, no step', async ({ page }) => {
    const user = await freshUser('none');
    await signIn(page, user);
    await expect(page.getByTestId('insights-page')).toBeVisible();
    await page.goto('/mfa/verify');
    await expect(page).toHaveURL(/\/$/);
  });

  test('@smoke turning it on, then every sign-in asks for the code', async ({
    page,
  }) => {
    const user = await freshUser('enable');
    await signIn(page, user);
    await expect(page.getByTestId('insights-page')).toBeVisible();
    await page.goto('/settings');
    await page.getByTestId('mfa-start').click();
    const secret = (await page.getByTestId('mfa-secret').textContent()) ?? '';
    const first = await totpCode(secret);
    await page.getByTestId('mfa-code').fill(first);
    await page.getByTestId('mfa-confirm').click();
    await expect(page.getByTestId('mfa-enabled')).toBeVisible();
    expect(await verifiedFactors(user.id)).toBe(1);

    // A new sign-in: the password alone no longer opens the dashboard.
    await page.context().clearCookies();
    await signIn(page, user);
    await expect(page).toHaveURL(/\/mfa\/verify$/);
    await page.getByTestId('mfa-verify-code').fill('000000');
    await page.getByTestId('mfa-verify-submit').click();
    await expect(page.getByTestId('mfa-verify-error')).toBeVisible();
    await expect(page).toHaveURL(/\/mfa\/verify$/);
    await giveCode(page, secret, first);
    await expect(page.getByTestId('insights-page')).toBeVisible();
  });

  test('@smoke cancelling the set-up leaves no factor', async ({ page }) => {
    const user = await freshUser('cancel');
    await signIn(page, user);
    await expect(page.getByTestId('insights-page')).toBeVisible();
    await page.goto('/settings');
    await page.getByTestId('mfa-start').click();
    await expect(page.getByTestId('mfa-qr')).toBeVisible();
    await page.getByTestId('mfa-cancel').click();
    await expect(page.getByTestId('mfa-start')).toBeVisible();
    await page.reload();
    await expect(page.getByTestId('mfa-start')).toBeVisible();
    const { data, error } = await admin().auth.admin.mfa.listFactors({
      userId: user.id,
    });
    expect(error).toBeNull();
    expect(data?.factors ?? []).toHaveLength(0);
  });

  test('@smoke the code step returns to the page that was asked for, and removal works after it', async ({
    page,
  }) => {
    const { user, secret, lastCode } = await userWithFactor('remove');
    await page.goto('/settings');
    await expect(page).toHaveURL(/\/login\?next=%2Fsettings$/);
    await signIn(page, user, page.url());
    await expect(page).toHaveURL(/\/mfa\/verify\?next=%2Fsettings$/);
    await giveCode(page, secret, lastCode);
    await expect(page).toHaveURL(/\/settings$/);
    await page.getByTestId('mfa-remove').click();
    await expect(page.getByTestId('mfa-start')).toBeVisible();
    expect(await verifiedFactors(user.id)).toBe(0);
  });

  test('@smoke the consent screen for an agent is behind the step', async ({
    page,
    request,
  }) => {
    const { user, secret, lastCode } = await userWithFactor('consent');
    const redirectUri = 'http://127.0.0.1:45791/callback';
    const registered = await request.post(
      `${e2eEnv.serverUrl}/oauth/register`,
      {
        data: {
          client_name: 'zm-e2e-mfa',
          redirect_uris: [redirectUri],
          token_endpoint_auth_method: 'none',
        },
      }
    );
    const clientId = (await registered.json()).client_id as string;
    const verifier = randomBytes(32).toString('base64url');
    const authorize = new URL(`${e2eEnv.serverUrl}/oauth/authorize`);
    authorize.search = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: 'S256',
      state: 'mfa',
    }).toString();

    await page.goto(authorize.toString());
    await signIn(page, user, page.url());
    await expect(page).toHaveURL(/\/mfa\/verify\?next=%2Foauth%2Fconsent/);
    await giveCode(page, secret, lastCode);
    await expect(page.getByTestId('oauth-consent-client')).toHaveText(
      'zm-e2e-mfa'
    );
  });

  test('@smoke deleting the account needs the factor and the code', async ({
    page,
  }) => {
    // Without a factor, deletion cannot start, and says why.
    const plain = await freshUser('delete-plain');
    await signIn(page, plain);
    await expect(page.getByTestId('insights-page')).toBeVisible();
    await page.goto('/settings');
    await expect(
      page.getByTestId('settings-delete-account-blocked')
    ).toBeVisible();
    await expect(
      page.getByTestId('settings-delete-account-open')
    ).toBeDisabled();

    // With a factor, a session that has not given the code is refused even
    // when it asks the route directly — which is what an agent's session,
    // presented to the dashboard, would be.
    await page.context().clearCookies();
    const { user, secret, lastCode } = await userWithFactor('delete');
    await signIn(page, user);
    await expect(page).toHaveURL(/\/mfa\/verify$/);
    const refused = await page.request.post('/settings/delete-account', {
      headers: { 'sec-fetch-site': 'same-origin' },
    });
    expect(refused.status()).toBe(403);
    expect(await refused.text()).toContain('code');
    // The other change the dashboard makes with the service role, the
    // person's model-provider key, is refused to that session as well.
    const keyWrite = await page.request.post('/settings/provider-key', {
      headers: { 'sec-fetch-site': 'same-origin' },
      data: {
        provider: 'openai',
        apiKey: 'e2e-fixture-not-a-real-key-0123456789',
      },
    });
    expect(keyWrite.status()).toBe(403);
    expect(await keyWrite.text()).toContain('code');
    const keyRevoke = await page.request.delete('/settings/provider-key', {
      headers: { 'sec-fetch-site': 'same-origin' },
    });
    expect(keyRevoke.status()).toBe(403);
    const { data: still } = await admin().auth.admin.getUserById(user.id);
    expect(still.user?.id).toBe(user.id);

    // After the code, the person deletes it in Settings.
    await giveCode(page, secret, lastCode);
    await expect(page.getByTestId('insights-page')).toBeVisible();
    await page.goto('/settings');
    await page.getByTestId('settings-delete-account-open').click();
    await page.getByTestId('settings-delete-account-input').fill(user.email);
    const erased = page.waitForResponse(
      (response) =>
        response.url().endsWith('/settings/delete-account') &&
        response.request().method() === 'POST'
    );
    await page.getByTestId('settings-delete-account-confirm').click();
    expect((await erased).status()).toBe(200);
    await expect(page).toHaveURL(/\/login/);
    const { data: gone } = await admin().auth.admin.getUserById(user.id);
    expect(gone.user).toBeNull();
  });
});
