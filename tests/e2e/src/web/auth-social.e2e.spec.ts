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
