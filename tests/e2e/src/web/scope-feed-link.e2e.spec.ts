/**
 * From a scope to its memories and back. The scope card title on /scopes
 * links to the memory feed pre-filtered to that scope, and a memory opened
 * from that filtered feed leads back to the same view: the card link carries
 * the feed's query as `from`, so "back to feed" restores the filter instead of
 * resetting the feed.
 */
import { expect, test } from '@playwright/test';

import { firstJson, McpTestClient } from '../helpers/mcp.js';
import { readSeedState } from '../helpers/runtime-state.js';
import { passwordGrantToken } from '../helpers/users.js';
import { signInThroughForm } from '../helpers/web.js';

test.describe('Scope card feed link', () => {
  test('the title opens the feed filtered by that scope, and a memory leads back to it', async ({
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
    const filtered = new RegExp(
      `/memories\\?.*scope=${encodeURIComponent(scope)}`
    );
    await expect(page).toHaveURL(filtered);
    const feed = page.getByTestId('memory-feed');
    await expect(feed.getByText(marker)).toBeVisible();

    // Open the memory from the filtered feed…
    await feed
      .getByTestId('memory-card')
      .filter({ hasText: marker })
      .getByText(marker)
      .click();

    // …then come back: the filter must be restored, not reset.
    await page.getByRole('link', { name: '← Back to feed' }).click();
    await expect(page).toHaveURL(filtered);
    await expect(feed.getByText(marker)).toBeVisible();
  });
});
