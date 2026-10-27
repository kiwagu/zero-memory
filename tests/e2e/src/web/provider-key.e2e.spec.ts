/**
 * Installing, replacing and withdrawing your own provider key from the
 * settings page.
 *
 * What a signed-in user can and cannot do with a stored key at the database —
 * read it, decrypt it, write it — and what replacing or withdrawing leaves
 * behind are the api spec's. This one covers what only the page shows: the
 * form reaching the store (a reload renders what was stored, not what the
 * panel remembered), and the key never sitting in what the browser renders.
 */
import { expect, test } from '@playwright/test';

import { admin } from '../helpers/board-store.js';
import { readSeedState } from '../helpers/runtime-state.js';
import { entityIdOf } from '../helpers/users.js';
import { signInThroughForm } from '../helpers/web.js';

/** Recognisable, and long enough to pass the shape check. */
const KEY = 'sk-ant-e2e-provider-key-DO-NOT-LEAK-7788';
const REPLACEMENT = 'sk-ant-e2e-second-provider-key-VALUE-9900';

const clearCredential = async (subjectId: string): Promise<void> => {
  await admin().rpc('revoke_provider_credential', { p_subject_id: subjectId });
};

test.describe('your own provider key', () => {
  test('is installed, replaced and revoked from the settings page', async ({
    page,
  }) => {
    const seed = await readSeedState();
    const subjectId = await entityIdOf(seed.userB.id);

    try {
      await clearCredential(subjectId);
      await signInThroughForm(page, seed.userB);
      await page.goto('/settings');

      const panel = page.getByTestId('settings-provider-key');
      await expect(panel).toBeVisible();
      const installed = page.getByTestId('settings-provider-key-installed');
      // Nothing installed yet.
      await expect(installed).toHaveCount(0);

      await page.getByTestId('settings-provider-key-input').fill(KEY);
      await page.getByTestId('settings-provider-key-save').click();

      await expect(installed).toBeVisible();
      // Recognisable by its last four characters, and by nothing more.
      await expect(installed).toContainText('7788');
      await expect(installed).not.toContainText(KEY);

      // The field is cleared once the key is stored, so it does not sit in the
      // page waiting to be screenshotted.
      await expect(page.getByTestId('settings-provider-key-input')).toHaveValue(
        ''
      );
      expect(await page.content()).not.toContain(KEY);

      // A fresh render reads the stored credential: the key reached the store,
      // and the server-rendered payload — where a careless "current value"
      // prop would land — carries the hint and not the key.
      await page.reload();
      await expect(installed).toContainText('7788');
      expect(await page.content()).not.toContain(KEY);

      // Replacing shows the new key's tail, and so does the next render.
      await page.getByTestId('settings-provider-key-input').fill(REPLACEMENT);
      await page.getByTestId('settings-provider-key-save').click();
      await expect(installed).toContainText('9900');
      await page.reload();
      await expect(installed).toContainText('9900');

      // Revoking clears the panel, and the next render finds nothing stored.
      await page.getByTestId('settings-provider-key-revoke').click();
      await expect(installed).toHaveCount(0);
      await page.reload();
      await expect(panel).toBeVisible();
      await expect(installed).toHaveCount(0);
    } finally {
      await clearCredential(subjectId);
    }
  });
});
