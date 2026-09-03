/**
 * Sign-up consent: a deployment that publishes legal documents must not be
 * able to create an account without an explicit acceptance, and the links in
 * that sentence must point where the deployment's configuration says. The
 * stand configures both address shapes (a site-root path and an absolute
 * URL) — see the web app's environment in scripts/run-e2e.ts.
 */
import { expect, test } from '@playwright/test';

test.describe('sign-up consent', () => {
  test('@smoke the acceptance and its links appear only in sign-up mode', async ({
    page,
  }) => {
    await page.goto('/login');
    // Signing in is not the moment to accept anything: the account already
    // exists and its holder accepted when they created it.
    await expect(page.getByTestId('auth-login-consent')).toBeHidden();

    await page.getByTestId('auth-login-switch-mode').click();
    await expect(page.getByTestId('auth-login-consent')).toBeVisible();
    await expect(page.getByTestId('auth-login-terms')).toHaveAttribute(
      'href',
      '/terms'
    );
    await expect(page.getByTestId('auth-login-privacy')).toHaveAttribute(
      'href',
      'https://example.test/privacy'
    );
  });

  test('@smoke an unaccepted form does not create an account', async ({
    page,
  }) => {
    await page.goto('/login');
    await page.getByTestId('auth-login-switch-mode').click();
    await page
      .getByTestId('auth-login-email')
      .fill(`consent-${Date.now()}@zero-memory.test`);
    await page.getByTestId('auth-login-password').fill('consent-password-1');

    await page.getByTestId('auth-login-submit').click();

    // The browser refuses the submission itself, so the form is still here and
    // the confirmation screen — the only proof an account was created — is not.
    await expect(page.getByTestId('auth-login-form')).toBeVisible();
    await expect(page.getByTestId('auth-signup-confirmation')).toBeHidden();
    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByTestId('auth-login-consent')).not.toBeChecked();
  });
});
