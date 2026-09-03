/**
 * The account's display name: set it in settings, and the dashboard stops
 * showing an e-mail address.
 *
 * Worth an e2e rather than a unit test because the value crosses three
 * boundaries that a unit test cannot see at once — a server action writes it to
 * auth metadata, the session token has to be re-minted for the claim to change,
 * and the layout reads it back off that token. The first version of this
 * feature saved correctly and still showed the old name, because only the last
 * of those three steps was missing.
 */
import { expect, test } from '@playwright/test';

import { readSeedState } from '../helpers/runtime-state.js';
import { signInThroughForm } from '../helpers/web.js';

/** Restores the account to "no name set" so a re-run starts from the fallback. */
const clearName = async (page: import('@playwright/test').Page) => {
  await page.goto('/settings');
  await page.getByTestId('profile-name').fill('');
  await page.getByTestId('profile-save').click();
  await expect(page.getByTestId('profile-saved')).toBeVisible();
};

test.describe('account display name', () => {
  test('@smoke a saved name replaces the address in the chrome', async ({
    page,
  }) => {
    const seed = await readSeedState();
    await signInThroughForm(page, seed.userA);
    await clearName(page);

    // With no name set, the chrome falls back to the address's local part —
    // never the whole address.
    await page.goto('/memories');
    const chrome = page.getByTestId('account-name');
    const localPart = seed.userA.email.split('@')[0]!;
    await expect(chrome).toHaveText(localPart);
    await expect(chrome).toHaveAttribute('title', seed.userA.email);

    await page.goto('/settings');
    await page.getByTestId('profile-name').fill('Ada Lovelace');
    await page.getByTestId('profile-save').click();
    await expect(page.getByTestId('profile-saved')).toBeVisible();

    // The name must be live in the SAME session — no re-login, no waiting for
    // the old token to expire.
    await page.goto('/memories');
    await expect(chrome).toHaveText('Ada Lovelace');
    await expect(chrome).toHaveAttribute('title', seed.userA.email);

    await clearName(page);
    await page.goto('/memories');
    await expect(chrome).toHaveText(localPart);
  });

  test('a name that would garble the chrome is refused', async ({ page }) => {
    const seed = await readSeedState();
    await signInThroughForm(page, seed.userA);
    await page.goto('/settings');

    // A bidi override renders as chrome on every screen; the write path
    // rejects control characters rather than storing them.
    await page.getByTestId('profile-name').fill('Ada‮ecilA');
    await page.getByTestId('profile-save').click();

    await expect(page.getByTestId('profile-error')).toBeVisible();
    await expect(page.getByTestId('profile-saved')).toHaveCount(0);
  });

  test('the address stays visible where it is the subject', async ({
    page,
  }) => {
    const seed = await readSeedState();
    await signInThroughForm(page, seed.userA);
    await page.goto('/settings');

    // Settings shows the full address as read-only context — the name replaces
    // it in the chrome, not everywhere.
    await expect(page.getByTestId('profile-email')).toHaveValue(
      seed.userA.email
    );
  });
});
