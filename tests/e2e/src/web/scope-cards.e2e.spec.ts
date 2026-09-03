/**
 * Scope cards on /scopes: the admin controls menu edits alias + description
 * through the dialog, and the saved alias becomes the card title (the raw
 * ltree path stays visible as the mono subtitle).
 */
import { expect, test } from '@playwright/test';

import { firstJson, McpTestClient } from '../helpers/mcp.js';
import { readSeedState } from '../helpers/runtime-state.js';
import { passwordGrantToken } from '../helpers/users.js';
import { signInThroughForm } from '../helpers/web.js';

test.describe('Scope card controls', () => {
  test('edit dialog saves an alias; the card shows it over the path', async ({
    page,
  }) => {
    const seed = await readSeedState();
    const mcp = await McpTestClient.connect(
      await passwordGrantToken(seed.userA)
    );
    let scope: string;
    try {
      const write = await mcp.callTool('remember', {
        content: 'scope-card marker: web alias flow fact',
        kind: 'fact',
        scope: 'proj.webcard_probe',
      });
      expect(write.isError ?? false).toBe(false);
      scope = firstJson<{ scope: string }>(write).scope;
    } finally {
      await mcp.close();
    }

    await signInThroughForm(page, seed.userA);
    await page.goto('/scopes');

    const card = page.locator('section', { hasText: scope }).first();
    // The trigger is server-rendered, so it is clickable BEFORE React attaches
    // its handler: under load the first click lands in the gap and the menu
    // never opens (this spec was the suite's one recurring red, failing even
    // on retry while passing in isolation). Re-click until the menu answers —
    // the same thing a person does when a button does nothing.
    await expect(async () => {
      await card.getByTestId('scope-controls-trigger').click();
      await expect(page.getByText('Edit alias & description')).toBeVisible({
        timeout: 2000,
      });
    }).toPass({ timeout: 20000 });
    await page.getByText('Edit alias & description').click();

    await page.getByTestId('scope-alias-input').fill('Webcard Probe');
    await page
      .getByTestId('scope-description-input')
      .fill('Probe scope for the card controls flow.');
    await page.getByTestId('scope-meta-save').click();

    // The card re-renders with the alias as title and the path beneath it.
    const renamedCard = page.locator('section', {
      hasText: 'Webcard Probe',
    });
    await expect(renamedCard.getByText(scope)).toBeVisible();
    await expect(
      renamedCard.getByText('Probe scope for the card controls flow.')
    ).toBeVisible();
  });
});
