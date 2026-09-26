/**
 * The board and a card page follow the agents while they are open: a card an
 * agent makes appears on the board, and a note an agent writes appears on the
 * card page, without the reader reloading anything.
 */
import { expect, test, type Page } from '@playwright/test';

import { admin } from '../helpers/board-store.js';
import { firstJson, McpTestClient } from '../helpers/mcp.js';
import { readSeedState } from '../helpers/runtime-state.js';
import { passwordGrantToken } from '../helpers/users.js';
import { signInThroughForm } from '../helpers/web.js';

interface CardResult {
  card: { id: string; number: number; scope: string };
}

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

test.describe('The board follows the agents while it is open', () => {
  test('a card an agent makes appears on the board, and its note on the card page, with no reload', async ({
    page,
  }) => {
    const seed = await readSeedState();
    const mcp = await McpTestClient.connect(
      await passwordGrantToken(seed.userA)
    );
    try {
      const made = firstJson<{ scope: string; memory_id: string }>(
        await mcp.callTool('remember', {
          content: `board-live web marker ${Date.now()}: the relay drops frames`,
          kind: 'fact',
          project_hint: `/tmp/zm-e2e-board-live-${Date.now()}`,
        })
      );
      markers.push(made.memory_id);
      const create = async (title: string) =>
        firstJson<CardResult>(
          await mcp.callTool('card', {
            action: 'create',
            scope: made.scope,
            title,
            no_links: 'e2e fixture',
          })
        ).card;
      const note = async (id: string, text: string) => {
        const noted = await mcp.callTool('card_log', {
          action: 'note',
          card_id: id,
          text,
        });
        expect(noted.isError ?? false).toBe(false);
      };
      await create('Rotate the relay keys');

      await signInThroughForm(page, seed.userA);
      await page.goto(`/board?scope=${encodeURIComponent(made.scope)}`);
      await expect(page.getByTestId('board-card')).toHaveCount(1);
      await markPage(page);

      // A page starts hearing its board a few seconds after it opens; a
      // change written before that is not delivered. So the agent keeps
      // touching the new card until the board shows it.
      const arrived = await create('Arrived while the board was open');
      await expect
        .poll(
          async () => {
            const shown = await page
              .getByTestId('board-card')
              .filter({ hasText: 'Arrived while the board was open' })
              .count();
            if (shown === 0) {
              await note(arrived.id, 'still here');
            }
            return shown;
          },
          { intervals: [2000], timeout: 40_000 }
        )
        .toBe(1);
      expect(await stillSamePage(page)).toBe(true);

      // The card's own page follows its stream the same way.
      await page.goto(`/board/${arrived.id}`);
      await expect(
        page.getByText('Arrived while the board was open')
      ).toBeVisible();
      await markPage(page);
      let n = 0;
      await expect
        .poll(
          async () => {
            const shown = await page.getByText(/heard live \d+/).count();
            if (shown === 0) {
              n += 1;
              await note(arrived.id, `heard live ${n}`);
            }
            return shown;
          },
          { intervals: [2000], timeout: 40_000 }
        )
        .toBeGreaterThan(0);
      expect(await stillSamePage(page)).toBe(true);
    } finally {
      await mcp.close();
    }
  });
});
