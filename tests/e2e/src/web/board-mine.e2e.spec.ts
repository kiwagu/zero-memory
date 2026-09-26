/**
 * The board's columns fold what went quiet past the horizon behind an arrow,
 * and the Mine view is the same board narrowed to my cards, with the card a
 * new session would continue marked on its tile. Like the rest of the board,
 * none of it changes a card.
 */
import { expect, test, type Locator, type Page } from '@playwright/test';

import {
  admin,
  asUser,
  makeMember,
  psql,
  rpc,
} from '../helpers/board-store.js';
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

const backdate = (id: string, days: number) =>
  psql(
    `update public.card_events set created_at = now() - interval '${days} days'
      where card_id = '${id}'`
  );

const column = (page: Page, state: string): Locator =>
  page.getByTestId(`board-column-${state}`);

/**
 * Hovers until the hint opens, and answers it: a hover that lands before the
 * page is interactive is lost, so each try moves away first.
 */
const hintOf = async (
  page: Page,
  target: Locator,
  hintTestId: string
): Promise<Locator> => {
  const tip = page.getByTestId(hintTestId);
  await expect(async () => {
    await page.mouse.move(0, 0);
    await target.hover();
    await expect(tip).toBeVisible({ timeout: 1000 });
  }).toPass({ timeout: 20_000 });
  return tip;
};

test.describe('The board folds what went quiet, and Mine is the same board', () => {
  test('Mine is the same board narrowed to my cards, with the card to continue marked', async ({
    page,
  }) => {
    const { seed, mcp, scope, create, note } = await boardOf('same');
    let keys: CardResult['card'];
    let feed: CardResult['card'];
    try {
      keys = await create('Rotate the relay keys', true);
      feed = await create('Page the memory feed', false);
      await note(feed.id, 'an idea for later');
      await note(keys.id, 'keys rotate weekly');
    } finally {
      await mcp.close();
    }

    await signInThroughForm(page, seed.userA);
    await page.goto(`/board?scope=${encodeURIComponent(scope)}`);
    // The offer shows on the regular board too: it is the reader's own.
    const offeredTile = column(page, 'active')
      .getByTestId('board-card')
      .filter({ hasText: `ZM-${keys.number}` });
    await expect(offeredTile.getByTestId('board-card-offered')).toBeVisible();

    await page.getByTestId('board-mine-toggle').click();
    await expect(page).toHaveURL(/[?&]mine=1(&|$)/);
    await expect(page).toHaveURL(/[?&]scope=/);
    // The same columns, the same tiles.
    await expect(page.getByTestId('board-columns')).toBeVisible();
    await expect(
      column(page, 'idea')
        .getByTestId('board-card')
        .filter({
          hasText: `ZM-${feed.number}`,
        })
    ).toHaveCount(1);
    await expect(offeredTile.getByTestId('board-card-offered')).toBeVisible();
    await expect(
      column(page, 'idea').getByTestId('board-card-offered')
    ).toHaveCount(0);
    await expect(offeredTile.getByTestId('board-card-offered')).toHaveAttribute(
      'title',
      /new session/
    );

    // The view survives a reload; a tile opens its card over the board.
    await page.reload();
    await expect(page.getByTestId('board-columns')).toBeVisible();
    await offeredTile.click();
    await expect(page).toHaveURL(new RegExp(`/board/${keys.id}`));
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('board-columns')).toBeVisible();

    // Off again: the address forgets it.
    await page.getByTestId('board-mine-toggle').click();
    await expect(page).not.toHaveURL(/[?&]mine=/);
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
    const tiles = page.getByTestId('board-card');
    await expect(tiles).toHaveCount(1);
    await expect(tiles).toContainText('Page the memory feed');
  });

  test('a column folds its cards untouched past the horizon behind an arrow in its header', async ({
    page,
  }) => {
    const { seed, mcp, scope, create } = await boardOf('fold');
    let stale: CardResult['card'];
    try {
      await create('Fresh idea', false);
      stale = await create('Stale idea', false);
    } finally {
      await mcp.close();
    }
    backdate(stale.id, 31);

    await signInThroughForm(page, seed.userA);
    await page.goto(`/board?scope=${encodeURIComponent(scope)}`);
    const ideas = column(page, 'idea');
    await expect(ideas.getByTestId('board-card')).toHaveCount(1);
    await expect(ideas.getByText('Stale idea')).toHaveCount(0);
    // No quiet cards, no arrow.
    await expect(
      column(page, 'active').getByTestId('board-column-older-toggle')
    ).toHaveCount(0);

    const arrow = ideas.getByTestId('board-column-older-toggle');
    await expect(arrow).toHaveAttribute('aria-expanded', 'false');
    const tip = await hintOf(page, arrow, 'board-column-older-hint');
    await expect(tip).toContainText('30+ days');

    await arrow.click();
    await expect(arrow).toHaveAttribute('aria-expanded', 'true');
    // What the arrow opened is set apart: a divider that says why, and
    // dimmed tiles below it.
    const opened = ideas.getByTestId('board-column-older');
    await expect(opened.getByText('Stale idea')).toBeVisible();
    await expect(
      opened.getByTestId('board-column-older-divider')
    ).toContainText('30+ days');
    await expect(opened.getByTestId('board-card')).toHaveAttribute(
      'data-quiet',
      'true'
    );
    await expect(
      ideas.getByTestId('board-card').filter({ hasText: 'Fresh idea' })
    ).not.toHaveAttribute('data-quiet', 'true');
    await arrow.click();
    await expect(ideas.getByText('Stale idea')).toHaveCount(0);
  });

  test("in Mine the fold follows my own last work, not anyone else's", async ({
    page,
  }) => {
    const { seed, mcp, scope, create } = await boardOf('fold-mine');
    let card: CardResult['card'];
    try {
      card = await create('Handed over long ago', false);
    } finally {
      await mcp.close();
    }
    backdate(card.id, 31);
    // Another member touches it now: the board sees it fresh, Mine does not.
    await makeMember(scope, seed.userB.id, 'writer');
    await rpc(asUser(await passwordGrantToken(seed.userB)), 'card_note', {
      p_card_id: card.id,
      p_text: 'picked up by a teammate',
    });

    await signInThroughForm(page, seed.userA);
    await page.goto(`/board?scope=${encodeURIComponent(scope)}`);
    const ideas = column(page, 'idea');
    await expect(ideas.getByText('Handed over long ago')).toBeVisible();
    await expect(ideas.getByTestId('board-column-older-toggle')).toHaveCount(0);

    await page.goto(`/board?scope=${encodeURIComponent(scope)}&mine=1`);
    await expect(ideas.getByText('Handed over long ago')).toHaveCount(0);
    const arrow = ideas.getByTestId('board-column-older-toggle');
    const tip = await hintOf(page, arrow, 'board-column-older-hint');
    await expect(tip).toContainText('you last worked on');
  });

  test('a board that cannot be read is an error, never an empty board', async ({
    page,
  }) => {
    const seed = await readSeedState();
    await signInThroughForm(page, seed.userA);
    // Not a scope at all: the store refuses it, so there is nothing to show.
    await page.goto('/board?scope=not%20a%20scope!&mine=1');
    await expect(page.getByRole('alert')).toBeVisible();
    await expect(page.getByTestId('board-columns')).toHaveCount(0);
    await expect(page.getByTestId('board-empty')).toHaveCount(0);
  });

  test('the offer follows the agent live', async ({ page }) => {
    const { seed, mcp, scope, create, note } = await boardOf('live');
    try {
      const first = await create('Rotate the relay keys', true);
      await note(first.id, 'keys first');

      await signInThroughForm(page, seed.userA);
      await page.goto(`/board?scope=${encodeURIComponent(scope)}&mine=1`);
      const badgeOn = (n: number) =>
        page
          .getByTestId('board-card')
          .filter({ hasText: `ZM-${n}` })
          .getByTestId('board-card-offered');
      await expect(badgeOn(first.number)).toBeVisible();

      // A page starts hearing its board a few seconds after it opens; a
      // change written before that is not delivered. So the agent keeps
      // working on the new card until the offer moves to it, with no reload.
      const next = await create('Ship the relay rollout', true);
      await expect
        .poll(
          async () => {
            const moved = (await badgeOn(next.number).count()) === 1;
            if (!moved) {
              await note(next.id, 'now the rollout');
            }
            return moved;
          },
          { intervals: [2000], timeout: 40_000 }
        )
        .toBe(true);
      await expect(badgeOn(first.number)).toHaveCount(0);
    } finally {
      await mcp.close();
    }
  });
});
