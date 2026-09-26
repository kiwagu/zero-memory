/**
 * The Mine view of the board: the cards I worked on, newest own work first,
 * and the card a new session would be offered, shown to the person, live,
 * without asking an agent. Like the rest of the board, it changes nothing.
 */
import { expect, test } from '@playwright/test';

import { admin, psql } from '../helpers/board-store.js';
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

const boardOf = async (tag: string) => {
  const seed = await readSeedState();
  const mcp = await McpTestClient.connect(await passwordGrantToken(seed.userA));
  const made = firstJson<{ scope: string; memory_id: string }>(
    await mcp.callTool('remember', {
      content: `board-mine web marker ${tag} ${Date.now()}: the relay drops frames`,
      kind: 'fact',
      project_hint: `/tmp/zm-e2e-board-mine-web-${tag}-${Date.now()}`,
    })
  );
  markers.push(made.memory_id);
  const create = async (title: string, active: boolean) =>
    firstJson<CardResult>(
      await mcp.callTool('card', {
        action: 'create',
        scope: made.scope,
        title,
        no_links: 'e2e fixture',
        ...(active ? { state: 'active', no_branch: 'e2e fixture' } : {}),
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
  return { seed, mcp, scope: made.scope, create, note };
};

test.describe('The Mine view of the board', () => {
  test('lists my cards newest first, offers the card to continue, and changes nothing', async ({
    page,
  }) => {
    const { seed, mcp, scope, create, note } = await boardOf('list');
    let keys: CardResult['card'];
    let feed: CardResult['card'];
    try {
      keys = await create('Rotate the relay keys', true);
      feed = await create('Page the memory feed', false);
      await note(keys.id, 'keys rotate weekly');
      await note(feed.id, 'an idea for later');
    } finally {
      await mcp.close();
    }

    await signInThroughForm(page, seed.userA);
    await page.goto(`/board?scope=${encodeURIComponent(scope)}`);
    await expect(page.getByTestId('board-columns')).toBeVisible();

    await page.getByTestId('board-mine-toggle').click();
    await expect(page).toHaveURL(/[?&]mine=1(&|$)/);
    await expect(page).toHaveURL(/[?&]scope=/);
    await expect(page.getByTestId('board-columns')).toHaveCount(0);

    // Newest own work first: the idea I noted last, then the active card.
    const tiles = page.getByTestId('board-mine-list').getByTestId('board-card');
    await expect(tiles).toHaveCount(2);
    await expect(tiles.nth(0)).toContainText(`ZM-${feed.number}`);
    await expect(tiles.nth(1)).toContainText(`ZM-${keys.number}`);
    await expect(tiles.nth(1)).toContainText('keys rotate weekly');

    // The offer is the active card; my last step was on the other one.
    const offer = page.getByTestId('board-continuation');
    await expect(offer.getByTestId('board-continuation-card')).toContainText(
      `ZM-${keys.number}`
    );
    await expect(
      offer.getByTestId('board-continuation-last-session')
    ).toContainText(`ZM-${feed.number}`);

    // Nothing here changes a card.
    for (const part of ['board-mine-list', 'board-continuation']) {
      await expect(page.getByTestId(part).getByRole('button')).toHaveCount(0);
      await expect(page.getByTestId(part).locator('form')).toHaveCount(0);
    }

    // The view survives a reload; the offer opens the card over the list.
    await page.reload();
    await expect(page.getByTestId('board-mine-list')).toBeVisible();
    await offer.getByTestId('board-continuation-card').click();
    await expect(page).toHaveURL(new RegExp(`/board/${keys.id}`));
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('board-mine-list')).toBeVisible();

    // Off again: the address forgets it and the columns return.
    await page.getByTestId('board-mine-toggle').click();
    await expect(page).not.toHaveURL(/[?&]mine=/);
    await expect(page.getByTestId('board-columns')).toBeVisible();
  });

  test('keeps the filter beside it', async ({ page }) => {
    const { seed, mcp, scope, create } = await boardOf('filter');
    try {
      await create('Rotate the relay keys', true);
      await create('Page the memory feed', false);
    } finally {
      await mcp.close();
    }
    await signInThroughForm(page, seed.userA);
    await page.goto(`/board?scope=${encodeURIComponent(scope)}&mine=1`);
    const search = page.getByTestId('board-search').getByRole('searchbox');
    await search.fill('memory feed');
    await search.press('Enter');
    await expect(page).toHaveURL(/[?&]mine=1(&|$)/);
    await expect(page).toHaveURL(/[?&]q=memory/);
    const tiles = page.getByTestId('board-mine-list').getByTestId('board-card');
    await expect(tiles).toHaveCount(1);
    await expect(tiles).toContainText('Page the memory feed');
  });

  test('marks work past the horizon, and says when nothing is left to continue', async ({
    page,
  }) => {
    const { seed, mcp, scope, create, note } = await boardOf('horizon');
    let stale: CardResult['card'];
    try {
      stale = await create('Rotate the relay keys', true);
      await note(stale.id, 'long ago');
    } finally {
      await mcp.close();
    }
    psql(
      `update public.card_events set created_at = now() - interval '31 days'
        where card_id = '${stale.id}'`
    );

    await signInThroughForm(page, seed.userA);
    await page.goto(`/board?scope=${encodeURIComponent(scope)}&mine=1`);
    const tile = page.getByTestId('board-mine-list').getByTestId('board-card');
    await expect(tile).toHaveCount(1);
    await expect(tile.getByTestId('board-card-past-horizon')).toBeVisible();
    await expect(page.getByTestId('board-continuation-empty')).toContainText(
      '30'
    );
  });

  test('the offer follows the agent live', async ({ page }) => {
    const { seed, mcp, scope, create, note } = await boardOf('live');
    try {
      const first = await create('Rotate the relay keys', true);
      await note(first.id, 'keys first');

      await signInThroughForm(page, seed.userA);
      await page.goto(`/board?scope=${encodeURIComponent(scope)}&mine=1`);
      const card = page.getByTestId('board-continuation-card');
      await expect(card).toContainText(`ZM-${first.number}`);

      // A page starts hearing its board a few seconds after it opens; a
      // change written before that is not delivered. So the agent keeps
      // working on the new card until the offer moves to it, with no reload.
      const next = await create('Ship the relay rollout', true);
      await expect
        .poll(
          async () => {
            const text = (await card.textContent()) ?? '';
            const moved = text.includes(`ZM-${next.number}`);
            if (!moved) {
              await note(next.id, 'now the rollout');
            }
            return moved;
          },
          { intervals: [2000], timeout: 40_000 }
        )
        .toBe(true);
    } finally {
      await mcp.close();
    }
  });
});
