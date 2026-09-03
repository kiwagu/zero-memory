/**
 * The scope card title on /scopes links to the memory feed pre-filtered to that
 * scope: clicking it lands on /memories with the `scope` query param set, and
 * the feed shows that scope's memory.
 */
import { expect, test } from '@playwright/test';

import { firstJson, McpTestClient } from '../helpers/mcp.js';
import { readSeedState } from '../helpers/runtime-state.js';
import { passwordGrantToken } from '../helpers/users.js';
import { signInThroughForm } from '../helpers/web.js';

test.describe('Scope card feed link', () => {
  test('the title links to the feed filtered by that scope', async ({
    page,
  }) => {
    const marker = 'scope-feedlink marker: filter redirect fact';
    const seed = await readSeedState();
    const mcp = await McpTestClient.connect(
      await passwordGrantToken(seed.userA)
    );
    let scope: string;
    try {
      const write = await mcp.callTool('remember', {
        content: marker,
        kind: 'fact',
        scope: 'proj.feedlink_probe',
      });
      expect(write.isError ?? false).toBe(false);
      scope = firstJson<{ scope: string }>(write).scope;
    } finally {
      await mcp.close();
    }

    await signInThroughForm(page, seed.userA);
    await page.goto('/scopes');

    const card = page.locator('section', { hasText: scope }).first();
    await card.getByTestId('scope-feed-link').click();

    // Landed on the feed with the scope filter set, showing that scope's memory.
    await expect(page).toHaveURL(
      new RegExp(`/memories\\?.*scope=${encodeURIComponent(scope)}`)
    );
    await expect(
      page.getByTestId('memory-feed').getByText(marker)
    ).toBeVisible();
  });
});
