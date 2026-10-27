/**
 * Turning the rule-delivery judge on, and installing and withdrawing its own
 * key, from the settings page.
 *
 * What a signed-in user can do with the judge tables at the database is the
 * api spec's. This one covers what only the page shows: the switch and the
 * key form reaching the store (a reload renders what was stored, not what the
 * panel remembered), an installed key choosing its provider, and the key
 * never sitting in what the browser renders.
 */
import { expect, test } from '@playwright/test';

import { admin } from '../helpers/board-store.js';
import { readSeedState } from '../helpers/runtime-state.js';
import { entityIdOf } from '../helpers/users.js';
import { signInThroughForm } from '../helpers/web.js';

/** 24 characters: long enough for the shape check, recognisable by its tail. */
const KEY = 'tsk-e2e-judge-key-QX7788';

const clearJudge = async (subjectId: string): Promise<void> => {
  await admin().rpc('revoke_judge_credential', { p_subject_id: subjectId });
  await admin().from('judge_settings').delete().eq('subject_id', subjectId);
};

const storedSettings = async (subjectId: string) => {
  const { data, error } = await admin()
    .from('judge_settings')
    .select('enabled, provider')
    .eq('subject_id', subjectId)
    .maybeSingle();
  if (error) {
    throw new Error(`judge_settings: ${error.message}`);
  }
  return data as { enabled: boolean; provider: string | null } | null;
};

const storedCredentialCount = async (subjectId: string): Promise<number> => {
  const { count, error } = await admin()
    .from('judge_credentials')
    .select('subject_id', { count: 'exact', head: true })
    .eq('subject_id', subjectId);
  if (error) {
    throw new Error(`judge_credentials: ${error.message}`);
  }
  return count ?? 0;
};

test.describe('the rule delivery judge', () => {
  test('is turned on, given its own key and has it revoked from the settings page', async ({
    page,
  }) => {
    const seed = await readSeedState();
    const subjectId = await entityIdOf(seed.userA.id);

    try {
      await clearJudge(subjectId);
      await signInThroughForm(page, seed.userA);

      // A change that names nothing to change is refused, and stores nothing.
      const empty = await page.request.patch('/settings/judge-provider', {
        headers: {
          'sec-fetch-site': 'same-origin',
          'content-type': 'application/json',
        },
        data: {},
      });
      expect(empty.status()).toBe(400);
      expect(await storedSettings(subjectId)).toBeNull();

      await page.goto('/settings');

      const card = page.getByTestId('settings-judge-provider');
      await expect(card).toBeVisible();
      await expect(card).toContainText('Rule delivery judge');
      const toggle = page.getByTestId('settings-judge-enable');
      const status = page.getByTestId('settings-judge-status');
      await expect(toggle).toHaveAttribute('aria-checked', 'false');
      await expect(status).toHaveText('Off: every rule arrives in full.');

      await toggle.click();
      await expect(toggle).toHaveAttribute('aria-checked', 'true');

      // A fresh render reads the stored choice, not the panel's memory of it.
      await page.reload();
      await expect(toggle).toHaveAttribute('aria-checked', 'true');
      await expect(status).toHaveText('Judging runs on the instance key.');
      expect(await storedSettings(subjectId)).toEqual({
        enabled: true,
        provider: null,
      });

      const installed = page.getByTestId('settings-judge-installed');
      await expect(installed).toHaveCount(0);
      await page
        .getByTestId('settings-judge-key-provider')
        .selectOption('typesafe');
      await page.getByTestId('settings-judge-key-input').fill(KEY);
      await page.getByTestId('settings-judge-save').click();

      // Recognisable by its last four characters, and by nothing more.
      await expect(installed).toContainText('ending 7788');
      await expect(installed).not.toContainText(KEY);
      await expect(page.getByTestId('settings-judge-key-input')).toHaveValue(
        ''
      );
      expect(await page.content()).not.toContain(KEY);
      // The installed key chose its provider, so the two cannot disagree.
      expect(await storedSettings(subjectId)).toEqual({
        enabled: true,
        provider: 'typesafe',
      });

      // The server-rendered payload carries the hint and not the key.
      await page.reload();
      await expect(installed).toContainText('ending 7788');
      expect(await page.content()).not.toContain(KEY);
      expect(await storedCredentialCount(subjectId)).toBe(1);

      await page.getByTestId('settings-judge-revoke').click();
      await expect(installed).toHaveCount(0);
      await expect.poll(() => storedCredentialCount(subjectId)).toBe(0);
      // Withdrawing the key leaves the provider choice as it was.
      expect(await storedSettings(subjectId)).toEqual({
        enabled: true,
        provider: 'typesafe',
      });
      await page.reload();
      await expect(card).toBeVisible();
      await expect(installed).toHaveCount(0);
    } finally {
      await clearJudge(subjectId);
    }
  });
});
