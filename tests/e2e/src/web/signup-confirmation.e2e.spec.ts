/**
 * What a new account sees after signing up. With email confirmation enabled the
 * sign-up returns no session, so the browser cannot proceed — and the screen has
 * to say so. It previously said it in one line on the same form, which then
 * flipped back to sign-in: indistinguishable from nothing having happened, and
 * the reported reaction was to retry rather than open the inbox.
 *
 * The assertions are about that: the form is GONE, the address is named, and the
 * confirmation mail is really in the mailbox.
 *
 * The stand publishes legal documents, so signing up here also means accepting
 * them — the same click a real person makes. What that gate does on its own is
 * covered by auth-consent.e2e.spec.ts; here it is only a step on the way.
 */
import { expect, test } from '@playwright/test';

import { purgeMailbox, waitForMail } from '../helpers/mail.js';

// A fresh address per run: an existing account would take the sign-in path and
// prove nothing about this screen.
const signUpEmail = (): string =>
  `e2e-signup-${Date.now().toString(36)}@zm.e2e`;
const PASSWORD = 'e2e-signup-password';

test.describe('sign-up confirmation', () => {
  test('@smoke a new account lands on a screen about its inbox, not on the form', async ({
    page,
  }) => {
    const email = signUpEmail();
    await purgeMailbox(email);

    await page.goto('/login');
    await page.getByTestId('auth-login-switch-mode').click();
    await page.getByTestId('auth-login-email').fill(email);
    await page.getByTestId('auth-login-password').fill(PASSWORD);
    await page.getByTestId('auth-login-consent').check();
    await page.getByTestId('auth-login-submit').click();

    const confirmation = page.getByTestId('auth-signup-confirmation');
    await expect(confirmation).toBeVisible();
    // The one thing the old notice could not do: name where the link went.
    await expect(
      page.getByTestId('auth-signup-confirmation-description')
    ).toContainText(email);
    // The form must be gone — its presence is what read as "nothing happened".
    await expect(page.getByTestId('auth-login-form')).toBeHidden();

    // And the mail it promises actually exists.
    const mail = await waitForMail(email);
    expect(mail.subject.length).toBeGreaterThan(0);
    expect(mail.html).not.toContain('{{ .');

    // Back to sign-in returns the form, so the screen is not a dead end.
    await page.getByTestId('auth-signup-confirmation-back').click();
    await expect(page.getByTestId('auth-login-form')).toBeVisible();
  });

  test('the link can be sent again from the same screen', async ({ page }) => {
    const email = signUpEmail();
    await purgeMailbox(email);

    await page.goto('/login');
    await page.getByTestId('auth-login-switch-mode').click();
    await page.getByTestId('auth-login-email').fill(email);
    await page.getByTestId('auth-login-password').fill(PASSWORD);
    await page.getByTestId('auth-login-consent').check();
    await page.getByTestId('auth-login-submit').click();
    await expect(page.getByTestId('auth-signup-confirmation')).toBeVisible();
    await waitForMail(email);

    const resend = page.getByTestId('auth-signup-confirmation-resend');
    await resend.click();
    // It reports the send and stands down, so a person cannot mash it.
    await expect(resend).toBeDisabled();
    await expect(
      page.getByTestId('auth-signup-confirmation-error')
    ).toBeHidden();
  });
});
