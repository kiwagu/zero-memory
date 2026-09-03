/**
 * Browser-side helpers: UI login through the real form (the same path a
 * user takes), landing on the dashboard default page (the value dashboard).
 */
import { expect, type Page } from '@playwright/test';

import type { E2EUser } from './users.js';

export const signInThroughForm = async (
  page: Page,
  user: E2EUser
): Promise<void> => {
  await page.goto('/login');
  await page.getByTestId('auth-login-email').fill(user.email);
  await page.getByTestId('auth-login-password').fill(user.password);
  await page.getByTestId('auth-login-submit').click();
  // Login lands on '/', which is now the value dashboard (insights).
  await expect(page.getByTestId('insights-page')).toBeVisible();
};
