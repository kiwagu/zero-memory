/**
 * The board in the dashboard: the parallel, human-readable view of what the
 * agents are doing.
 *
 * Two things are proven here. The board SHOWS the work — a card sits in the
 * column its state names, and its move carries the reason its author gave.
 * And the board CANNOT TOUCH the work: the page offers no control that changes
 * a card's state, because a drag has nowhere to put a justification. That
 * absence is the feature, so it is asserted rather than assumed.
 */
import { expect, test } from '@playwright/test';

import { firstJson, McpTestClient } from '../helpers/mcp.js';
import { readSeedState } from '../helpers/runtime-state.js';
import { passwordGrantToken } from '../helpers/users.js';
import { signInThroughForm } from '../helpers/web.js';

const REASON = 'blocked on the owner picking a cutover window';

interface CardResult {
  card: { id: string; number: number };
}

test.describe('Project board in the dashboard', () => {
  test('shows a card in its column with the reason it was moved, and offers no way to move it', async ({
    page,
  }) => {
    const seed = await readSeedState();
    const mcp = await McpTestClient.connect(
      await passwordGrantToken(seed.userA)
    );

    let cardId: string;
    let cardNumber: number;
    try {
      const loop = await mcp.callTool('remember', {
        content:
          'board-web marker: migrate the ingest worker off the legacy queue',
        kind: 'task',
        project_hint: '/tmp/zm-e2e-board-web',
      });
      expect(loop.isError ?? false).toBe(false);
      const { memory_id: loopId } = firstJson<{ memory_id: string }>(loop);

      const promoted = await mcp.callTool('card', {
        action: 'promote_loop',
        loop_id: loopId,
        title: 'Migrate the ingest worker',
        body: 'Goal: no traffic on the legacy queue.',
      });
      expect(promoted.isError ?? false).toBe(false);
      const card = firstJson<CardResult>(promoted).card;
      cardId = card.id;
      cardNumber = card.number;

      const moved = await mcp.callTool('card', {
        action: 'move',
        card_id: cardId,
        to: 'waiting',
        reason: REASON,
      });
      expect(moved.isError ?? false).toBe(false);

      const noted = await mcp.callTool('card_log', {
        action: 'note',
        card_id: cardId,
        text: 'I consider this finished from my side.',
      });
      expect(noted.isError ?? false).toBe(false);

      const attached = await mcp.callTool('card_log', {
        action: 'attach',
        card_id: cardId,
        ref_kind: 'memory',
        ref_target: loopId,
      });
      expect(attached.isError ?? false).toBe(false);
    } finally {
      await mcp.close();
    }

    await signInThroughForm(page, seed.userA);

    // The board: the card sits in the column its state names.
    await page.goto('/board');
    await expect(page.getByTestId('board')).toBeVisible();
    const waiting = page.getByTestId('board-column-waiting');
    const tile = waiting.getByTestId('board-card').filter({
      hasText: 'Migrate the ingest worker',
    });
    await expect(tile).toHaveCount(1);
    // The reason the card is in THIS column rides on the tile, and survives
    // the note and the attachment that happened after the move.
    await expect(tile).toContainText(REASON);
    await expect(tile).toContainText(`#${cardNumber}`);

    // Narrower than its five columns, the board scrolls inside its own row.
    // The page itself never widens, so the header and the picker stay whole.
    await page.setViewportSize({ width: 1100, height: 800 });
    const row = page.getByTestId('board-columns');
    await expect
      .poll(() => row.evaluate((node) => node.scrollWidth > node.clientWidth))
      .toBe(true);
    expect(
      await page.evaluate(
        () =>
          document.documentElement.scrollWidth <=
          document.documentElement.clientWidth
      )
    ).toBe(true);
    await page.setViewportSize({ width: 1280, height: 720 });

    // Opening a card is a DIALOG over the board — and the address bar still
    // names the card, so the step is navigable, shareable and reloadable.
    await tile.click();
    await expect(page.getByTestId('card-modal')).toBeVisible();
    // One shared, thin scrollbar across the dashboard, and a scrollbar that
    // appears never shifts the layout.
    expect(
      await page.evaluate(
        () => getComputedStyle(document.documentElement).scrollbarWidth
      )
    ).toBe('thin');
    expect(
      await page.evaluate(
        () => getComputedStyle(document.documentElement).scrollbarGutter
      )
    ).toBe('stable');
    await expect(page).toHaveURL(new RegExp(`/board/${cardId}$`));
    // The board is still there underneath, not replaced.
    await expect(page.getByTestId('board')).toBeVisible();
    await expect(page.getByTestId('card-detail')).toBeVisible();
    await expect(page.getByTestId('card-title')).toContainText(
      'Migrate the ingest worker'
    );
    await expect(page.getByTestId('card-state')).toContainText(/waiting/i);
    await expect(page.getByTestId('card-body')).toContainText('legacy queue');
    await expect(page.getByTestId('card-refs')).toContainText(
      'board-web marker'
    );
    const history = page.getByTestId('card-history');
    await expect(history).toContainText(REASON);
    await expect(history).toContainText(
      'I consider this finished from my side'
    );

    // A note claiming the work is finished did NOT move the card.
    await expect(page.getByTestId('card-state')).not.toContainText(/done/i);

    // THE READ-ONLY INVARIANT: the page carries no control that could change
    // the card. Every state move must arrive through a tool, with a reason.
    const detail = page.getByTestId('card-detail');
    await expect(detail.getByRole('button')).toHaveCount(0);
    await expect(detail.locator('select')).toHaveCount(0);
    await expect(detail.locator('form')).toHaveCount(0);
    await expect(detail.locator('[draggable="true"]')).toHaveCount(0);

    // Dismissing goes back to the board rather than pushing it again.
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('card-modal')).toBeHidden();
    await expect(page).toHaveURL(/\/board$/);

    // The same address opened DIRECTLY is a page of its own, not a dialog:
    // a reload or a pasted link must land on the card, not on nothing.
    await page.goto(`/board/${cardId}`);
    await expect(page.getByTestId('card-detail')).toBeVisible();
    await expect(page.getByTestId('card-title')).toContainText(
      'Migrate the ingest worker'
    );
    await expect(page.getByTestId('card-modal')).toHaveCount(0);
    await expect(page.getByTestId('board')).toHaveCount(0);
  });

  test('opens the board that moved last, and the picker switches boards', async ({
    page,
  }) => {
    const seed = await readSeedState();
    const mcp = await McpTestClient.connect(
      await passwordGrantToken(seed.userA)
    );

    let quietTitle: string;
    let busyTitle: string;

    try {
      const quietMemory = await mcp.callTool('remember', {
        content: 'board-picker marker: the quiet project',
        kind: 'fact',
        project_hint: '/tmp/zm-e2e-board-quiet',
      });
      const quietScope = firstJson<{ scope: string }>(quietMemory).scope;
      quietTitle = `Quiet board card ${Date.now()}`;
      const quietCard = await mcp.callTool('card', {
        action: 'create',
        scope: quietScope,
        title: quietTitle,
      });
      expect(quietCard.isError ?? false).toBe(false);

      const busyMemory = await mcp.callTool('remember', {
        content: 'board-picker marker: the busy project',
        kind: 'fact',
        project_hint: '/tmp/zm-e2e-board-busy',
      });
      const busyScope = firstJson<{ scope: string }>(busyMemory).scope;
      busyTitle = `Busy board card ${Date.now()}`;
      const busyCard = await mcp.callTool('card', {
        action: 'create',
        scope: busyScope,
        title: busyTitle,
      });
      expect(busyCard.isError ?? false).toBe(false);
      // One more touch, so "moved last" is unambiguous.
      const busyId = firstJson<CardResult>(busyCard).card.id;
      await mcp.callTool('card', {
        action: 'move',
        card_id: busyId,
        to: 'active',
        reason: 'starting here, which makes this the board that moved last',
      });
    } finally {
      await mcp.close();
    }

    await signInThroughForm(page, seed.userA);

    // A bare /board opens the board that moved last — and says so without
    // putting the choice in the address.
    await page.goto('/board');
    await expect(page.getByTestId('board')).toBeVisible();
    await expect(page.getByText(busyTitle)).toBeVisible();
    await expect(page.getByText(quietTitle)).toHaveCount(0);
    await expect(page).toHaveURL(/\/board$/);

    // The picker exists because there is a choice to make, and switching to
    // "all boards" is an explicit, addressable state.
    const picker = page.getByTestId('board-scope-filter');
    await expect(picker).toBeVisible();
    // The control NAMES the board the default picked, so "opened on the
    // latest activity" is something the reader can see rather than infer.
    await expect(picker).toContainText('zm_e2e_board_busy');
    await picker.click();
    await page.getByRole('option', { name: 'All boards' }).click();
    await expect(page).toHaveURL(/scope=all/);
    await expect(page.getByText(busyTitle)).toBeVisible();
    await expect(page.getByText(quietTitle)).toBeVisible();

    // A board named in the address that holds nothing shows EMPTY — it is not
    // quietly replaced by a board that has work on it, and the picker still
    // says which board is on screen.
    await page.goto('/board?scope=proj.usr_nobody_00000000.nothing_here');
    await expect(page.getByTestId('board-empty')).toBeVisible();
    await expect(page.getByTestId('board-scope-filter')).toBeVisible();
    await expect(page.getByTestId('board-scope-filter')).toContainText(
      'nothing_here'
    );
  });

  test('a card shows what its bound conversation remembered', async ({
    page,
  }) => {
    const seed = await readSeedState();
    const mcp = await McpTestClient.connect(
      await passwordGrantToken(seed.userA)
    );
    // A fresh project per run, so the marker is born in THIS conversation
    // rather than merged into a row from an earlier run.
    const hint = `/tmp/zm-e2e-board-web-feed-${Date.now()}`;

    let cardId: string;
    try {
      const pack = firstJson<{ session?: { thread?: string } }>(
        await mcp.callTool('build_context', {
          topic: 'card feed in the dashboard',
          briefing: true,
          project_hint: hint,
        })
      );
      const thread = pack.session?.thread;
      expect(thread).toBeTruthy();

      const stored = await mcp.callTool('remember', {
        content:
          'board-web feed marker: the report build now waits for the backup ' +
          'to finish',
        kind: 'decision',
        project_hint: hint,
      });
      expect(stored.isError ?? false).toBe(false);
      const { scope } = firstJson<{ scope: string }>(stored);

      const created = await mcp.callTool('card', {
        action: 'create',
        scope,
        title: 'Order the nightly jobs',
      });
      expect(created.isError ?? false).toBe(false);
      cardId = firstJson<CardResult>(created).card.id;

      const bound = await mcp.callTool('card_log', {
        action: 'attach',
        card_id: cardId,
        ref_kind: 'thread',
        ref_target: thread,
      });
      expect(bound.isError ?? false).toBe(false);
    } finally {
      await mcp.close();
    }

    await signInThroughForm(page, seed.userA);
    await page.goto(`/board/${cardId}`);

    // Never attached, yet on the card: it was born in the bound conversation.
    const feed = page.getByTestId('card-feed');
    await expect(feed).toContainText('report build now waits');
    await expect(page.getByTestId('card-refs')).not.toContainText(
      'report build now waits'
    );
  });

  test('a card body renders as markdown, and hostile markup stays inert', async ({
    page,
  }) => {
    const seed = await readSeedState();
    const mcp = await McpTestClient.connect(
      await passwordGrantToken(seed.userA)
    );
    let cardId: string;
    try {
      // A card lives on a project board; the scope comes from a write routed
      // by the same hint, the way the api board specs obtain it.
      const anchor = await mcp.callTool('remember', {
        content: 'board-markdown marker: anchors the card to its project',
        kind: 'fact',
        project_hint: '/tmp/zm-e2e-board-markdown',
      });
      expect(anchor.isError ?? false).toBe(false);
      const scope = firstJson<{ scope: string }>(anchor).scope;

      const created = await mcp.callTool('card', {
        action: 'create',
        scope,
        title: 'Markdown card',
        body: [
          '**Goal** is readable.',
          '',
          '- first item',
          '- second item',
          '',
          'Literal <Dialog> stays. <img src=x onerror="window.__pwned=1">',
          '',
          '[click me](javascript:window.__pwned=1)',
        ].join('\n'),
      });
      expect(created.isError ?? false).toBe(false);
      cardId = firstJson<CardResult>(created).card.id;
    } finally {
      await mcp.close();
    }

    await signInThroughForm(page, seed.userA);
    await page.goto(`/board/${cardId}`);
    const body = page.getByTestId('card-body');
    await expect(body.locator('strong')).toHaveText('Goal');
    await expect(body.locator('li')).toHaveCount(2);
    // Text that looks like markup is shown, never interpreted or dropped.
    await expect(body).toContainText('<Dialog>');
    await expect(body.locator('img')).toHaveCount(0);
    await expect(body.locator('a', { hasText: 'click me' })).toHaveCount(0);
    expect(
      await page.evaluate(
        () => (window as unknown as { __pwned?: number }).__pwned
      )
    ).toBeUndefined();
  });
});
