/**
 * Installing, replacing and withdrawing your own provider key — and, most of
 * all, where that key does NOT end up.
 *
 * A stored key must be unreachable by every route a user has: not in the page
 * it was typed into, not in the row the dashboard reads, not through the
 * database as the signed-in role. Those are asserted here rather than only in
 * SQL, because this is the surface a person actually touches.
 */
import { createClient } from '@supabase/supabase-js';
import { expect, test } from '@playwright/test';

import { e2eEnv } from '../helpers/env.js';
import { readSeedState } from '../helpers/runtime-state.js';
import { passwordGrantToken, userRestClient } from '../helpers/users.js';
import { signInThroughForm } from '../helpers/web.js';

/** Recognisable, and long enough to pass the shape check. */
const KEY = 'sk-ant-e2e-provider-key-DO-NOT-LEAK-7788';
const REPLACEMENT = 'sk-ant-e2e-second-provider-key-VALUE-9900';

const admin = () =>
  createClient(e2eEnv.supabaseUrl, e2eEnv.supabaseServiceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

const entityIdOf = async (authUserId: string): Promise<string> => {
  const { data, error } = await admin()
    .from('profiles')
    .select('id')
    .eq('user_id', authUserId)
    .single();
  if (error) throw new Error(`no profile for ${authUserId}: ${error.message}`);
  return (data as { id: string }).id;
};

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
      // Nothing installed yet.
      await expect(
        page.getByTestId('settings-provider-key-installed')
      ).toHaveCount(0);

      await page.getByTestId('settings-provider-key-input').fill(KEY);
      await page.getByTestId('settings-provider-key-save').click();

      const installed = page.getByTestId('settings-provider-key-installed');
      await expect(installed).toBeVisible();
      // Recognisable by its last four characters, and by nothing more.
      await expect(installed).toContainText('7788');
      await expect(installed).not.toContainText(KEY);

      // The field is cleared once the key is stored, so it does not sit in the
      // page waiting to be screenshotted.
      await expect(page.getByTestId('settings-provider-key-input')).toHaveValue(
        ''
      );

      // Replacing keeps exactly one credential, now recognisable by the new
      // key's tail.
      await page.getByTestId('settings-provider-key-input').fill(REPLACEMENT);
      await page.getByTestId('settings-provider-key-save').click();
      await expect(installed).toContainText('9900');

      const { data: rows } = await admin()
        .from('provider_credentials')
        .select('subject_id, hint')
        .eq('subject_id', subjectId);
      expect(rows).toHaveLength(1);
      expect((rows?.[0] as { hint: string }).hint).toBe('9900');

      // Revoking removes the row and the secret behind it.
      await page.getByTestId('settings-provider-key-revoke').click();
      await expect(
        page.getByTestId('settings-provider-key-installed')
      ).toHaveCount(0);

      const { data: afterRevoke } = await admin()
        .from('provider_credentials')
        .select('subject_id')
        .eq('subject_id', subjectId);
      expect(afterRevoke).toHaveLength(0);

      const { data: secrets } = await admin()
        .schema('vault')
        .from('secrets')
        .select('id')
        .eq('name', `provider_credential:${subjectId}`);
      expect(secrets ?? []).toHaveLength(0);
    } finally {
      await clearCredential(subjectId);
    }
  });

  test('is never readable by the user who stored it', async ({ page }) => {
    const seed = await readSeedState();
    const subjectId = await entityIdOf(seed.userB.id);

    try {
      await clearCredential(subjectId);
      await signInThroughForm(page, seed.userB);
      await page.goto('/settings');
      await page.getByTestId('settings-provider-key-input').fill(KEY);
      await page.getByTestId('settings-provider-key-save').click();
      await expect(
        page.getByTestId('settings-provider-key-installed')
      ).toBeVisible();

      // Not anywhere in the rendered page — including the server-rendered
      // payload, which is where a careless "current value" prop would land.
      expect(await page.content()).not.toContain(KEY);

      // Not through the row the user is allowed to read.
      const asUser = userRestClient(await passwordGrantToken(seed.userB));
      const { data: visible } = await asUser
        .from('provider_credentials')
        .select('*');
      expect(visible).toHaveLength(1);
      expect(JSON.stringify(visible)).not.toContain(KEY);

      // Not through the function that can decrypt it.
      const { error: rpcError } = await asUser.rpc('provider_credential_for', {
        p_subject_id: subjectId,
      });
      expect(rpcError).not.toBeNull();

      // Not through the vault itself.
      const { error: vaultError } = await asUser
        .schema('vault')
        .from('decrypted_secrets')
        .select('*');
      expect(vaultError).not.toBeNull();
    } finally {
      await clearCredential(subjectId);
    }
  });
});
