/**
 * Dashboard auth boundary: guests are pushed to the login form, wrong
 * credentials surface an inline error, valid credentials land on the feed.
 */
import { expect, test } from '@playwright/test';

import { readSeedState } from '../helpers/runtime-state.js';
import { signInThroughForm } from '../helpers/web.js';

test.describe('dashboard login', () => {
  test('@smoke guest is redirected to the login form', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByTestId('auth-login-form')).toBeVisible();
  });

  test('@smoke wrong password shows an inline error and stays on /login', async ({
    page,
  }) => {
    const seed = await readSeedState();
    await page.goto('/login');
    await page.getByTestId('auth-login-email').fill(seed.userA.email);
    await page.getByTestId('auth-login-password').fill('wrong-password');
    await page.getByTestId('auth-login-submit').click();
    await expect(page.getByTestId('auth-login-error')).toBeVisible();
    await expect(page).toHaveURL(/\/login$/);
  });

  test('@smoke valid credentials land on the value dashboard', async ({
    page,
  }) => {
    const seed = await readSeedState();
    await signInThroughForm(page, seed.userA);
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByTestId('insights-page')).toBeVisible();
  });
});
