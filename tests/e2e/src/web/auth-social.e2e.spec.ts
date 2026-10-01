/**
 * Social sign-in on the dashboard, without a real provider: which buttons the
 * instance's Auth settings produce, how Auth answers an enabled and a disabled
 * provider, and what an account created by a provider meets on its first
 * visit — the one-time acceptance of the stand's legal documents.
 */
import { createClient } from '@supabase/supabase-js';
import { expect, test } from '@playwright/test';

import { e2eEnv } from '../helpers/env.js';
import { provisionE2EUser } from '../helpers/users.js';

const adminClient = () =>
  createClient(e2eEnv.supabaseUrl, e2eEnv.supabaseServiceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

test.describe('provider buttons', () => {
  test('@smoke the login page draws exactly the providers the instance enables', async ({
    page,
  }) => {
    // The stand enables github with throwaway credentials and leaves google
    // off (tests/e2e/supabase/config.toml); the page must mirror that.
    await page.goto('/login');
    await expect(page.getByTestId('auth-login-provider-github')).toBeVisible();
    await expect(page.getByTestId('auth-login-provider-google')).toHaveCount(0);
    await expect(page.getByTestId('auth-login-divider')).toBeVisible();

    await expect(page.getByTestId('auth-login-linked-hint')).toBeHidden();
    await page.getByTestId('auth-login-switch-mode').click();
    await expect(page.getByTestId('auth-login-linked-hint')).toBeVisible();
  });

  test('@smoke the button hands the browser to the provider through Auth', async ({
    page,
  }) => {
    // github.com is not reachable from the suite and must not be: the proof
    // stops at the hand-off, which Auth performs with a redirect to it.
    await page.route('https://github.com/**', (route) =>
      route.fulfill({ status: 200, body: 'provider stub' })
    );
    await page.goto('/login');
    const handoff = page.waitForRequest((request) =>
      request.url().startsWith('https://github.com/login/oauth/authorize')
    );
    await page.getByTestId('auth-login-provider-github').click();
    const request = await handoff;
    const url = new URL(request.url());
    expect(url.searchParams.get('client_id')).toBe('e2e-github-client-id');
    // Auth's own callback is what the provider is told to return to.
    expect(url.searchParams.get('redirect_uri')).toBe(
      `${e2eEnv.supabaseUrl}/auth/v1/callback`
    );
  });

  test('@smoke an enabled provider is a redirect, a disabled one a refusal', async ({
    request,
  }) => {
    const redirectTo = encodeURIComponent(`${e2eEnv.webUrl}/auth/callback`);
    const github = await request.get(
      `${e2eEnv.supabaseUrl}/auth/v1/authorize?provider=github&redirect_to=${redirectTo}`,
      { maxRedirects: 0 }
    );
    expect(github.status()).toBe(302);
    expect(github.headers()['location']).toMatch(
      /^https:\/\/github\.com\/login\/oauth\/authorize\?/
    );

    const google = await request.get(
      `${e2eEnv.supabaseUrl}/auth/v1/authorize?provider=google&redirect_to=${redirectTo}`,
      { maxRedirects: 0 }
    );
    expect(google.status()).toBe(400);
    expect(await google.text()).toContain('not enabled');
  });
});

test.describe('auth callback', () => {
  test('@smoke a callback without a code lands on the login page with the reason', async ({
    page,
  }) => {
    await page.goto('/auth/callback');
    await expect(page).toHaveURL(/\/login\?error=missing_code$/);
    await expect(page.getByTestId('auth-login-error')).toBeVisible();
  });

  test("@smoke a provider's refusal reaches the login page as the reason, not as a missing code", async ({
    page,
  }) => {
    // What Auth sends back when the person cancels at the provider.
    await page.goto(
      '/auth/callback?error=access_denied&error_code=provider_denied&error_description=The+user+denied+access'
    );
    await expect(page).toHaveURL(/\/login\?error=/);
    await expect(page.getByTestId('auth-login-error')).toHaveText(
      'The user denied access'
    );
  });

  test('@smoke a refusal carried in the URL fragment is shown too', async ({
    page,
  }) => {
    // Auth puts the reason in the fragment when there is no code to exchange
    // (a spent or expired link, an implicit-flow error).
    await page.goto(
      '/login#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired'
    );
    await expect(page.getByTestId('auth-login-error')).toHaveText(
      'Email link is invalid or has expired'
    );
  });
});

test.describe('terms for an account that never accepted them', () => {
  test('@smoke a provider-created account accepts the terms once, then returns where it was going', async ({
    page,
  }) => {
    // No acceptance on the account: exactly what a sign-up through a provider
    // leaves behind, since the provider's flow carries no metadata.
    const user = await provisionE2EUser(`terms-${Date.now()}@zm.e2e`, {
      acceptedTerms: false,
    });

    await page.goto('/settings');
    await expect(page).toHaveURL(/\/login\?next=%2Fsettings$/);
    await page.getByTestId('auth-login-email').fill(user.email);
    await page.getByTestId('auth-login-password').fill(user.password);
    await page.getByTestId('auth-login-submit').click();

    // Not the settings page yet: the acceptance comes first, and the page
    // that was asked for rides along as the return path.
    await expect(page).toHaveURL(/\/accept-terms\?next=%2Fsettings$/);
    await expect(page.getByTestId('auth-login-terms')).toHaveAttribute(
      'href',
      '/terms'
    );
    // Nothing in the dashboard opens around the gate — and the page last
    // asked for becomes the return path.
    await page.goto('/memories');
    await expect(page).toHaveURL(/\/accept-terms\?next=%2Fmemories$/);

    await page.getByTestId('accept-terms-consent').check();
    await page.getByTestId('accept-terms-submit').click();
    await expect(page).toHaveURL(/\/memories$/);

    const { data } = await adminClient().auth.admin.getUserById(user.id);
    expect(typeof data.user?.user_metadata.terms_accepted_at).toBe('string');

    // Asked once: the next visit goes straight through.
    await page.goto('/settings');
    await expect(page).toHaveURL(/\/settings$/);
  });

  test('@smoke the gate can be left by signing out, and records nothing', async ({
    page,
  }) => {
    const user = await provisionE2EUser(`terms-${Date.now()}-c@zm.e2e`, {
      acceptedTerms: false,
    });
    await page.goto('/login');
    await page.getByTestId('auth-login-email').fill(user.email);
    await page.getByTestId('auth-login-password').fill(user.password);
    await page.getByTestId('auth-login-submit').click();
    await expect(page).toHaveURL(/\/accept-terms$/);

    await page.getByTestId('accept-terms-sign-out').click();
    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByTestId('auth-login-form')).toBeVisible();
    // Signed out for real: the dashboard is a guest's view again.
    await page.goto('/memories');
    await expect(page).toHaveURL(/\/login\?next=%2Fmemories$/);

    const { data } = await adminClient().auth.admin.getUserById(user.id);
    expect(data.user?.user_metadata.terms_accepted_at ?? null).toBeNull();
  });

  test('@smoke an unticked acceptance does not pass', async ({ page }) => {
    const user = await provisionE2EUser(`terms-${Date.now()}-b@zm.e2e`, {
      acceptedTerms: false,
    });
    await page.goto('/login');
    await page.getByTestId('auth-login-email').fill(user.email);
    await page.getByTestId('auth-login-password').fill(user.password);
    await page.getByTestId('auth-login-submit').click();
    await expect(page).toHaveURL(/\/accept-terms$/);

    await page.getByTestId('accept-terms-submit').click();
    // The browser refuses the submission itself; the form is still here.
    await expect(page).toHaveURL(/\/accept-terms$/);
    await expect(page.getByTestId('accept-terms-form')).toBeVisible();
  });
});
