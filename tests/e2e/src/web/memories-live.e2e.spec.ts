/**
 * The memories feed follows the agents while it is open: a memory an agent
 * writes appears in the feed without the reader reloading anything.
 */
import { expect, test, type Page } from '@playwright/test';

import { admin, asUser } from '../helpers/board-store.js';
import { firstJson, McpTestClient } from '../helpers/mcp.js';
import { readSeedState } from '../helpers/runtime-state.js';
import { entityIdOf, passwordGrantToken } from '../helpers/users.js';
import { signInThroughForm } from '../helpers/web.js';

/**
 * Memories this spec writes land on page one of the default feed, where the
 * feed specs expect their own fixtures, so they are deleted when it is done.
 */
const markers: string[] = [];

test.afterAll(async () => {
  if (markers.length > 0) {
    await admin().from('memories').delete().in('id', markers);
  }
});

/** Marks the page, so a later check can tell it was never reloaded. */
const markPage = (page: Page) =>
  page.evaluate(() => {
    (window as unknown as { liveMark: boolean }).liveMark = true;
  });

const stillSamePage = (page: Page) =>
  page.evaluate(
    () => (window as unknown as { liveMark?: boolean }).liveMark === true
  );

test.describe('The memories feed follows the agents while it is open', () => {
  test('a memory an agent writes appears in the feed with no reload', async ({
    page,
  }) => {
    const seed = await readSeedState();
    const token = await passwordGrantToken(seed.userA);
    const readerId = await entityIdOf(seed.userA.id);

    await signInThroughForm(page, seed.userA);
    await page.goto('/memories');
    await expect(page.getByTestId('memory-feed')).toBeVisible();
    await markPage(page);

    const text = `memories-live ${Date.now()}: the relay drops frames under load`;
    const mcp = await McpTestClient.connect(token);
    try {
      const written = await mcp.callTool('remember', {
        content: text,
        kind: 'fact',
        scope: 'personal',
      });
      expect(written.isError ?? false).toBe(false);
      markers.push(firstJson<{ memory_id: string }>(written).memory_id);
    } finally {
      await mcp.close();
    }

    // A page starts hearing its channel a few seconds after it opens; a
    // change written before that is not delivered. So the reader's own
    // harmless writes keep nudging until the feed shows the agent's memory.
    const feed = page.getByTestId('memory-feed');
    await expect
      .poll(
        async () => {
          if ((await feed.getByText(text).count()) === 0) {
            const { data } = await asUser(token)
              .from('memories')
              .insert({
                content: `memories-live poke ${Date.now()}`,
                kind: 'fact',
                scope: `user.${readerId.replaceAll('.', '_')}`,
                visibility: 'private',
              })
              .select('id')
              .single();
            if (data) {
              markers.push((data as { id: string }).id);
            }
          }
          return feed.getByText(text).count();
        },
        { intervals: [2000], timeout: 45_000 }
      )
      .toBeGreaterThan(0);
    expect(await stillSamePage(page)).toBe(true);
  });
});
