/**
 * Advanced (ranked) memory search on /memories: the dashboard query runs
 * through the same `recall` tool an MCP client calls, so the rendered list
 * must match a direct tool call with identical args — same ids, same order.
 */
import { expect, test } from '@playwright/test';

import { firstJson, McpTestClient } from '../helpers/mcp.js';
import { readSeedState } from '../helpers/runtime-state.js';
import { passwordGrantToken } from '../helpers/users.js';
import { signInThroughForm } from '../helpers/web.js';

const QUERY = 'what does the e2e fixture say about the dashboard feed?';
const TOP_K = 10;

test.describe('advanced memory search', () => {
  test('@smoke ranked results match a direct MCP recall (ids and order)', async ({
    page,
  }) => {
    const seed = await readSeedState();
    await signInThroughForm(page, seed.userA);
    await page.goto('/memories');

    await page.getByTestId('advanced-search-toggle').click();
    await page.getByTestId('advanced-search-query').fill(QUERY);
    await page.getByTestId('advanced-search-submit').click();

    const results = page.getByTestId('search-results');
    await expect(results).toBeVisible();
    const domIds = await results.getByTestId('memory-id').allTextContents();
    expect(domIds.length).toBeGreaterThan(0);

    // The web path always opts into translate-then-search; the parity call
    // passes the identical args (a Latin-script query, so no translation
    // fires on either path).
    const mcp = await McpTestClient.connect(
      await passwordGrantToken(seed.userA)
    );
    try {
      const recalled = await mcp.callTool('recall', {
        query: QUERY,
        k: TOP_K,
      });
      expect(recalled.isError ?? false).toBe(false);
      const body = firstJson<{ memories: Array<{ id: string }> }>(recalled);
      expect(domIds).toEqual(body.memories.map((memory) => memory.id));
    } finally {
      await mcp.close();
    }

    // The top hit anchors the normalized scale.
    await expect(results.getByTestId('memory-score').first()).toContainText(
      '100%'
    );
  });

  test('deep link reproduces the ranked view without touching the panel', async ({
    page,
  }) => {
    const seed = await readSeedState();
    await signInThroughForm(page, seed.userA);
    await page.goto(`/memories?search=${encodeURIComponent(QUERY)}&k=5`);

    const results = page.getByTestId('search-results');
    await expect(results).toBeVisible();
    const count = await results.getByTestId('memory-card').count();
    expect(count).toBeGreaterThan(0);
    expect(count).toBeLessThanOrEqual(5);
  });

  test('empty result shows the search empty state; clear returns the feed', async ({
    page,
  }) => {
    const seed = await readSeedState();
    await signInThroughForm(page, seed.userA);
    // No e2e seed creates `reference` memories (episodes ARE seeded — the
    // reflection fixtures), so this filter is reliably empty.
    await page.goto(
      `/memories?search=${encodeURIComponent(QUERY)}&kinds=reference`
    );

    const results = page.getByTestId('search-results');
    await expect(results).toBeVisible();
    await expect(results.getByTestId('memory-card')).toHaveCount(0);

    await page.getByTestId('advanced-search-clear').click();
    await expect(page.getByTestId('memory-feed')).toBeVisible();
  });
});
