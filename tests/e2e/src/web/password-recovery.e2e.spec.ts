/**
 * Password recovery end to end, through the mail a user actually receives: the
 * dashboard requests a reset, Auth sends it through the stand's mail catcher,
 * and the link in OUR template gets the user to a working new password.
 *
 * This is the only place in the suite that walks the authentication mail path.
 * Everywhere else provisions users through the admin API, which is exactly how an
 * instance with no mail configured at all stayed green for so long — so the
 * assertions here deliberately cover the template as well as the flow: our
 * subject, our markup, and no unsubstituted GoTrue variable left in the body.
 */
import { expect, test } from '@playwright/test';

import {
  extractActionLink,
  listMailbox,
  purgeMailbox,
  waitForMail,
} from '../helpers/mail.js';
import { passwordGrantToken, provisionE2EUser } from '../helpers/users.js';

const RECOVERY_EMAIL = 'e2e-recovery@zm.e2e';
const UNKNOWN_EMAIL = 'e2e-nobody@zm.e2e';
const NEW_PASSWORD = 'e2e-recovered-password';

test.describe('password recovery', () => {
  test('@smoke a reset link from the mail we send sets a new password', async ({
    page,
  }) => {
    // Re-provisioning also restores the known password, so a previous run that
    // changed it does not make this one start from an unknown state.
    const user = await provisionE2EUser(RECOVERY_EMAIL);
    await purgeMailbox(user.email);

    await page.goto('/forgot-password');
    await page.getByTestId('auth-forgot-email').fill(user.email);
    await page.getByTestId('auth-forgot-submit').click();
    // The request is answered by a screen, not a line under a form still
    // standing: it names the address, and the form it replaces is gone.
    await expect(page.getByTestId('auth-forgot-sent')).toBeVisible();
    await expect(
      page.getByTestId('auth-forgot-sent-description')
    ).toContainText(user.email);
    await expect(page.getByTestId('auth-forgot-form')).toBeHidden();

    const mail = await waitForMail(user.email);

    // The subject comes from the mail catalog; GoTrue's own default reads
    // "Reset Your Password", so this alone proves our template is in use.
    expect(mail.subject).toBe('Reset your password');
    expect(mail.html).toContain('shared memory for coding agents');
    expect(mail.html).toContain('Reset your password');
    // Every variable substituted: a leftover `{{ .` means the template shipped
    // its placeholder to the user instead of their data.
    expect(mail.html).not.toContain('{{ .');
    expect(mail.text.length).toBeGreaterThan(0);

    await page.goto(extractActionLink(mail.html));
    await expect(page).toHaveURL(/\/reset-password/);
    await expect(page.getByTestId('auth-reset-form')).toBeVisible();

    await page.getByTestId('auth-reset-password').fill(NEW_PASSWORD);
    await page.getByTestId('auth-reset-confirm').fill(NEW_PASSWORD);
    await page.getByTestId('auth-reset-submit').click();
    // A FRESH link is never answered as a dead one. The form appears before
    // the link has been exchanged for a session, so a submit landing in that
    // window used to be refused with "this link is no longer valid" — a false
    // statement whose natural remedy, requesting a new link, throws away the
    // good one. The control now waits for the exchange instead.
    await expect(page.getByTestId('auth-reset-error')).toBeHidden();
    await expect(page.getByTestId('insights-page')).toBeVisible();

    // The credential itself changed, not just this session — checked out of
    // band so the browser's signed-in state cannot make the assertion vacuous.
    await expect(
      passwordGrantToken({ ...user, password: NEW_PASSWORD })
    ).resolves.toBeTruthy();
  });

  test('a spent recovery link cannot be replayed', async ({ page }) => {
    const user = await provisionE2EUser(RECOVERY_EMAIL);
    await purgeMailbox(user.email);

    await page.goto('/forgot-password');
    await page.getByTestId('auth-forgot-email').fill(user.email);
    await page.getByTestId('auth-forgot-submit').click();
    await expect(page.getByTestId('auth-forgot-sent')).toBeVisible();

    const link = extractActionLink((await waitForMail(user.email)).html);

    await page.goto(link);
    await expect(page.getByTestId('auth-reset-form')).toBeVisible();

    // A recovery link found in a mailbox later (a shared inbox, a forwarded
    // message) must be worthless once used, or the reset window never closes.
    // Replayed from a FRESH context, because that is the threat: someone with the
    // link and no session of their own.
    const browser = page.context().browser();
    if (!browser) {
      throw new Error('No browser available for a second context');
    }
    const stranger = await browser.newContext();
    try {
      const strangerPage = await stranger.newPage();
      await strangerPage.goto(link);
      // Auth refuses a spent link by redirecting to SITE_URL with the reason in
      // the URL FRAGMENT — it never reaches our /auth/callback, so there is no
      // code to exchange and no reset form to fill.
      await expect(strangerPage).toHaveURL(
        /error_code=otp_expired|error=access_denied/
      );
      await expect(strangerPage.getByTestId('auth-reset-form')).toBeHidden();
    } finally {
      await stranger.close();
    }
  });

  test('recovery for an unknown address sends nothing and reveals nothing', async ({
    page,
  }) => {
    await purgeMailbox(UNKNOWN_EMAIL);

    await page.goto('/forgot-password');
    await page.getByTestId('auth-forgot-email').fill(UNKNOWN_EMAIL);
    await page.getByTestId('auth-forgot-submit').click();

    // Identical outcome to a real address, on purpose: a different message here
    // would turn this form into an account-enumeration oracle.
    await expect(page.getByTestId('auth-forgot-sent')).toBeVisible();
    await expect(page.getByTestId('auth-forgot-error')).toBeHidden();

    // Fixed wait rather than a poll: the assertion is that nothing arrives, and
    // Auth sends within a second when it sends at all.
    await page.waitForTimeout(3000);
    expect(await listMailbox(UNKNOWN_EMAIL)).toHaveLength(0);
  });
});
