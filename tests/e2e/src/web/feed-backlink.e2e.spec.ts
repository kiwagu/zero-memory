/**
 * Drilling into a memory from a filtered feed and coming back preserves the
 * filters: the card link carries the feed's query as `from`, and the detail's
 * "back to feed" returns to that same filtered view instead of a reset feed.
 */
import { expect, test } from '@playwright/test';

import { firstJson, McpTestClient } from '../helpers/mcp.js';
import { readSeedState } from '../helpers/runtime-state.js';
import { passwordGrantToken } from '../helpers/users.js';
import { signInThroughForm } from '../helpers/web.js';

test.describe('Feed back-link', () => {
  test('back to feed from a memory restores the scope filter', async ({
    page,
  }) => {
    const marker = 'feed-backlink marker: preserve filters fact';
    const seed = await readSeedState();
    const mcp = await McpTestClient.connect(
      await passwordGrantToken(seed.userA)
    );
    let scope: string;
    try {
      const write = await mcp.callTool('remember', {
        content: marker,
        kind: 'fact',
        scope: 'proj.backlink_probe',
      });
      expect(write.isError ?? false).toBe(false);
      scope = firstJson<{ scope: string }>(write).scope;
    } finally {
      await mcp.close();
    }

    await signInThroughForm(page, seed.userA);
    await page.goto(`/memories?scope=${encodeURIComponent(scope)}`);

    // Open the memory from the filtered feed…
    const card = page
      .getByTestId('memory-feed')
      .getByTestId('memory-card')
      .filter({ hasText: marker });
    await card.getByText(marker).click();

    // …then come back: the filter must be restored, not reset.
    await page.getByRole('link', { name: '← Back to feed' }).click();
    await expect(page).toHaveURL(
      new RegExp(`/memories\\?.*scope=${encodeURIComponent(scope)}`)
    );
    await expect(
      page.getByTestId('memory-feed').getByText(marker)
    ).toBeVisible();
  });
});
