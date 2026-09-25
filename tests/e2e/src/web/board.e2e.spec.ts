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
import { expect, test, type Page } from '@playwright/test';

import { firstJson, McpTestClient } from '../helpers/mcp.js';
import { readSeedState } from '../helpers/runtime-state.js';
import { passwordGrantToken } from '../helpers/users.js';
import { signInThroughForm } from '../helpers/web.js';

const REASON = 'blocked on the owner picking a cutover window';

interface CardResult {
  card: { id: string; number: number; scope: string };
}

/**
 * Opens the board's hint. The hint opens on a pointer move, and a hover that
 * lands before a heavy board is interactive is lost — the pointer then sits
 * still over the icon and nothing opens it. So each try moves away first.
 */
const openBoardHint = async (page: Page): Promise<void> => {
  await expect(async () => {
    await page.mouse.move(0, 0);
    await page.getByTestId('board-hint').hover();
    await expect(page.getByTestId('board-hint-content')).toBeVisible({
      timeout: 1000,
    });
  }).toPass({ timeout: 20_000 });
};

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
    let cardScope: string;
    // A board of its own per attempt. A retry on a shared one would meet the
    // loop the failed attempt already promoted (the same text deduplicates to
    // the same memory, which cannot be promoted twice) and that attempt's card.
    const hint = `/tmp/zm-e2e-board-web-${Date.now()}`;
    try {
      const loop = await mcp.callTool('remember', {
        content:
          'board-web marker: migrate the ingest worker off the legacy queue',
        kind: 'task',
        project_hint: hint,
      });
      expect(loop.isError ?? false).toBe(false);
      const { memory_id: loopId } = firstJson<{ memory_id: string }>(loop);

      const promoted = await mcp.callTool('card', {
        action: 'promote_loop',
        no_links: 'e2e fixture',
        loop_id: loopId,
        title: 'Migrate the ingest worker',
        body: 'Goal: no traffic on the legacy queue.',
        no_branch: 'an e2e fixture card with no code',
      });
      expect(promoted.isError ?? false).toBe(false);
      const card = firstJson<CardResult>(promoted).card;
      cardId = card.id;
      cardNumber = card.number;
      cardScope = card.scope;

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
    // This card's own board, by scope: without one the page opens the board
    // that moved last, and specs running in parallel keep moving theirs.
    await page.goto(`/board?scope=${encodeURIComponent(cardScope)}`);
    await expect(page.getByTestId('board')).toBeVisible();
    const waiting = page.getByTestId('board-column-waiting');
    const tile = waiting.getByTestId('board-card').filter({
      hasText: 'Migrate the ingest worker',
    });
    await expect(tile).toHaveCount(1);
    // The reason the card is in THIS column rides on the tile, and survives
    // the note and the attachment that happened after the move.
    await expect(tile).toContainText(REASON);
    await expect(tile).toContainText(`ZM-${cardNumber}`);

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
    // The first card a run opens compiles the dialog's route on the dev
    // server, which on a shared runner can take longer than a default wait.
    await expect(page.getByTestId('card-modal')).toBeVisible({
      timeout: 20_000,
    });
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
    await expect(page).toHaveURL(/\/board(\?[^/]*)?$/);

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
        no_links: 'e2e fixture',
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
        no_links: 'e2e fixture',
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
        no_branch: 'an e2e fixture card with no code',
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
        no_links: 'e2e fixture',
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

  test('the filter beside the picker narrows the board by label or title, and the address keeps it', async ({
    page,
  }) => {
    const seed = await readSeedState();
    const mcp = await McpTestClient.connect(
      await passwordGrantToken(seed.userA)
    );
    let scope: string;
    let certs: CardResult['card'];
    let feed: CardResult['card'];
    try {
      scope = firstJson<{ scope: string }>(
        await mcp.callTool('remember', {
          content: `board-web filter marker ${Date.now()}: the edge proxy drops long polls`,
          kind: 'fact',
          project_hint: `/tmp/zm-e2e-board-web-filter-${Date.now()}`,
        })
      ).scope;
      const create = async (title: string) =>
        firstJson<CardResult>(
          await mcp.callTool('card', {
            action: 'create',
            scope,
            title,
            no_links: 'e2e fixture',
          })
        ).card;
      certs = await create('Rotate the edge certificates');
      feed = await create('Page the memory feed');
    } finally {
      await mcp.close();
    }

    await signInThroughForm(page, seed.userA);
    await page.goto(`/board?scope=${encodeURIComponent(scope)}`);
    const tiles = page.getByTestId('board-card');
    await expect(tiles).toHaveCount(2);
    const search = page.getByTestId('board-search').getByRole('searchbox');

    // The label a commit or a briefing names the card by.
    await search.fill(`ZM-${feed.number}`);
    await search.press('Enter');
    await expect(page).toHaveURL(new RegExp(`[?&]q=ZM-${feed.number}(&|$)`));
    await expect(tiles).toHaveCount(1);
    await expect(tiles).toContainText('Page the memory feed');
    // The scope stays chosen, and a reload keeps the filter.
    await expect(page).toHaveURL(/[?&]scope=/);
    await page.reload();
    await expect(tiles).toHaveCount(1);
    await expect(search).toHaveValue(`ZM-${feed.number}`);

    // A bare number and a title fragment find their cards too.
    await search.fill(String(certs.number));
    await search.press('Enter');
    await expect(tiles).toHaveCount(1);
    await expect(tiles).toContainText('Rotate the edge certificates');
    await search.fill('memory feed');
    await search.press('Enter');
    await expect(tiles).toHaveCount(1);
    await expect(tiles).toContainText('Page the memory feed');

    // Nothing matches: the columns are empty — no other card stands in.
    await search.fill('ZM-999');
    await search.press('Enter');
    await expect(page).toHaveURL(/[?&]q=ZM-999(&|$)/);
    await expect(tiles).toHaveCount(0);

    // An empty filter clears the query and shows the whole board again.
    await search.fill('');
    await search.press('Enter');
    await expect(page).not.toHaveURL(/[?&]q=/);
    await expect(tiles).toHaveCount(2);
  });

  test('a card shows the production version that carries it, and the board shows where production lives', async ({
    page,
  }) => {
    const seed = await readSeedState();
    const mcp = await McpTestClient.connect(
      await passwordGrantToken(seed.userA)
    );
    let scope: string;
    let cardId: string;
    try {
      scope = firstJson<{ scope: string }>(
        await mcp.callTool('remember', {
          content: `board-web release marker ${Date.now()}: ship the feed pages`,
          kind: 'fact',
          project_hint: `/tmp/zm-e2e-board-web-release-${Date.now()}`,
        })
      ).scope;
      const configured = await mcp.callTool('release', {
        action: 'configure',
        scope,
        version_url: 'https://api.example.com/healthz',
      });
      expect(configured.isError ?? false).toBe(false);
      cardId = firstJson<CardResult>(
        await mcp.callTool('card', {
          action: 'create',
          no_links: 'e2e fixture',
          scope,
          title: 'Ship the feed pages',
          state: 'active',
          branch: { repo: 'acme/memory-service', name: 'feature/feed-ship' },
        })
      ).card.id;
      await mcp.callTool('card', {
        action: 'land',
        card_id: cardId,
        branch: { repo: 'acme/memory-service', name: 'feature/feed-ship' },
        squash_sha: '5e22b66',
        target: 'main',
        reason: 'gate green; waits for the release',
      });
      const recorded = await mcp.callTool('release', {
        action: 'record',
        scope,
        version: '1.4.0',
        build: 'abc1234',
        release_commit: '6f33c77',
        source: 'url',
        card_ids: [cardId],
      });
      expect(recorded.isError ?? false).toBe(false);
    } finally {
      await mcp.close();
    }

    await signInThroughForm(page, seed.userA);
    await page.goto(`/board?scope=${encodeURIComponent(scope)}`);
    // What the board is and where production lives are read once, not on
    // every visit: they sit in the hint beside the title, off the page itself.
    await expect(page.getByTestId('board-hint-content')).toHaveCount(0);
    await openBoardHint(page);
    await expect(page.getByTestId('board-hint-content')).toContainText(
      'The board is a window'
    );
    await expect(page.getByTestId('board-release-settings')).toContainText(
      'https://api.example.com/healthz'
    );
    const tile = page
      .getByTestId('board-column-waiting')
      .getByTestId('board-card')
      .filter({ hasText: 'Ship the feed pages' });
    await expect(tile).toContainText('shipped in v1.4.0');

    await page.goto(`/board?scope=all`);
    await openBoardHint(page);
    await expect(page.getByTestId('board-hint-content')).toContainText(
      'The board is a window'
    );
    await expect(page.getByTestId('board-release-settings')).toHaveCount(0);

    await page.goto(`/board/${cardId}`);
    await expect(page.getByTestId('card-detail')).toContainText(
      'shipped in v1.4.0'
    );
    await expect(page.getByTestId('card-history')).toContainText('released');
    await expect(page.getByTestId('card-history')).toContainText('v1.4.0');
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
        no_links: 'e2e fixture',
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

/*
 * The chain of panels a card dialog opens. A link inside the card opens its
 * target as a twin panel to the right — memory, card or entity — and the
 * canvas grows without losing anything: a new panel goes right after the one
 * it was opened from, an open resource is never opened twice, × closes a panel
 * with everything opened from it, and Escape unwinds by opening order before
 * it closes the dialog. The address stays the card's throughout.
 */
test.describe('Panel chain in the card dialog', () => {
  test('a card label in a card text opens that card as the next panel', async ({
    page,
  }) => {
    const seed = await readSeedState();
    const stamp = Date.now();
    const sourceTitle = `mention source ${stamp}`;
    const targetTitle = `mention target ${stamp}`;
    const mcp = await McpTestClient.connect(
      await passwordGrantToken(seed.userA)
    );

    let boardScope: string;
    let sourceId: string;
    let targetId: string;
    let targetNumber: number;
    let foreignNumber: number;
    try {
      // Two fresh boards, so card numbers on each start from scratch: a label
      // means a card only on its own board.
      const boardOf = async (hint: string) => {
        const anchor = await mcp.callTool('remember', {
          content: `card-mentions anchor ${stamp} for ${hint}`,
          kind: 'fact',
          project_hint: hint,
        });
        expect(anchor.isError ?? false).toBe(false);
        return firstJson<{ scope: string }>(anchor).scope;
      };
      const create = async (scope: string, title: string, body = '') => {
        const created = await mcp.callTool('card', {
          action: 'create',
          no_links: 'e2e fixture',
          scope,
          title,
          body,
        });
        expect(created.isError ?? false).toBe(false);
        return firstJson<CardResult>(created).card;
      };

      boardScope = await boardOf(`/tmp/zm-e2e-card-mentions-${stamp}`);
      const otherScope = await boardOf(
        `/tmp/zm-e2e-card-mentions-other-${stamp}`
      );

      const target = await create(boardScope, targetTitle);
      targetId = target.id;
      targetNumber = target.number;
      const others = [];
      for (const n of [1, 2, 3]) {
        others.push(await create(otherScope, `mention other ${n} ${stamp}`));
      }

      const placeholder = await create(boardScope, sourceTitle);
      sourceId = placeholder.id;
      const taken = new Set([targetNumber, placeholder.number]);
      foreignNumber =
        others.map((card) => card.number).find((n) => !taken.has(n)) ?? -1;
      expect(foreignNumber).toBeGreaterThan(0);

      const edited = await mcp.callTool('card', {
        action: 'edit',
        card_id: sourceId,
        body: [
          `Blocked by ZM-${targetNumber}.`,
          '',
          `As code: \`ZM-${targetNumber}\``,
          '',
          `Unknown: ZM-999999. Another board's: ZM-${foreignNumber}.`,
          '',
          'No card can have ZM-99999999999.',
        ].join('\n'),
      });
      expect(edited.isError ?? false).toBe(false);
      const noted = await mcp.callTool('card_log', {
        action: 'note',
        card_id: sourceId,
        text: `Waits on ZM-${targetNumber} before it starts.`,
      });
      expect(noted.isError ?? false).toBe(false);
    } finally {
      await mcp.close();
    }

    await signInThroughForm(page, seed.userA);
    await page.goto(`/board?scope=${encodeURIComponent(boardScope)}`);
    await page
      .getByTestId('board-card')
      .filter({ hasText: sourceTitle })
      .click();
    await expect(page.getByTestId('card-modal')).toBeVisible();

    const body = page.getByTestId('card-body').first();
    const label = `ZM-${targetNumber}`;
    // The label of a card on this board is a link; the same label in code,
    // a number no card has, and a card of another board stay text.
    await expect(body.getByRole('link', { name: label })).toHaveCount(1);
    await expect(body.locator('code')).toHaveText(label);
    await expect(body.getByRole('link', { name: 'ZM-999999' })).toHaveCount(0);
    // A number past what a card can have is text, and the card still opens.
    await expect(body).toContainText('ZM-99999999999');
    await expect(
      body.getByRole('link', { name: `ZM-${foreignNumber}` })
    ).toHaveCount(0);
    // A note in the history links the same way.
    await expect(
      page.getByTestId('card-note').first().getByRole('link', { name: label })
    ).toHaveCount(1);

    // A click opens the mentioned card as the next panel; the card the reader
    // came from stays on screen and keeps the address.
    await body.getByRole('link', { name: label }).click();
    await expect
      .poll(() =>
        page
          .getByTestId('panel')
          .evaluateAll((nodes) =>
            nodes.map((node) => node.getAttribute('data-panel-key'))
          )
      )
      .toEqual([`card:${sourceId}`, `card:${targetId}`]);
    await expect(
      page.locator(`[data-panel-key="card:${targetId}"]`)
    ).toContainText(targetTitle);
    await expect(page).toHaveURL(new RegExp(`/board/${sourceId}$`));
  });

  test('links in a card build a canvas of panels to its right', async ({
    page,
  }) => {
    const seed = await readSeedState();
    const stamp = Date.now();
    const entityName = `e2e-panel-entity-${stamp}`;
    const cardTitle = `panel-chain card ${stamp}`;
    const mcp = await McpTestClient.connect(
      await passwordGrantToken(seed.userA)
    );

    let aId: string;
    let bId: string;
    let cId: string;
    let cardId: string;
    let cardNumber: number;
    let boardScope: string;
    try {
      const remember = async (args: Record<string, unknown>) => {
        const stored = await mcp.callTool('remember', {
          kind: 'fact',
          project_hint: '/tmp/zm-e2e-panel-chain',
          ...args,
        });
        expect(stored.isError ?? false).toBe(false);
        return firstJson<{ memory_id: string; scope: string }>(stored);
      };
      const b = await remember({
        content: `panel-chain B ${stamp}: the retry budget is five attempts`,
      });
      bId = b.memory_id;
      boardScope = b.scope;
      aId = (
        await remember({
          content: `panel-chain A ${stamp}: the queue drains nightly, see ${bId}`,
          entities: [{ name: entityName, type: 'concept' }],
        })
      ).memory_id;
      cId = (
        await remember({
          content: `panel-chain C ${stamp}: cutover waits for the owner`,
        })
      ).memory_id;

      const created = await mcp.callTool('card', {
        action: 'create',
        no_links: 'e2e fixture',
        scope: b.scope,
        title: cardTitle,
        body: 'panel-chain card body',
      });
      expect(created.isError ?? false).toBe(false);
      const card = firstJson<CardResult>(created).card;
      cardId = card.id;
      cardNumber = card.number;
      for (const target of [aId, cId]) {
        const attached = await mcp.callTool('card_log', {
          action: 'attach',
          card_id: cardId,
          ref_kind: 'memory',
          ref_target: target,
        });
        expect(attached.isError ?? false).toBe(false);
      }
    } finally {
      await mcp.close();
    }

    await signInThroughForm(page, seed.userA);
    // The card's own board, by scope: without one the page opens the board
    // that moved last, and specs running in parallel keep moving theirs.
    const openCard = async () => {
      await page.goto(`/board?scope=${encodeURIComponent(boardScope)}`);
      await page
        .getByTestId('board-card')
        .filter({ hasText: cardTitle })
        .click();
      await expect(page.getByTestId('card-modal')).toBeVisible();
    };
    const order = () =>
      page
        .getByTestId('panel')
        .evaluateAll((nodes) =>
          nodes.map((node) => node.getAttribute('data-panel-key'))
        );
    const panel = (key: string) => page.locator(`[data-panel-key="${key}"]`);
    const refs = page.getByTestId('card-refs').first();
    const cardKey = `card:${cardId}`;
    const aKey = `memory:${aId}`;
    const bKey = `memory:${bId}`;
    const cKey = `memory:${cId}`;

    await openCard();

    // 1. A link in the card opens a twin panel to its right; the URL stays
    //    the card's, and the panel says where it came from.
    await refs.getByRole('link', { name: /panel-chain A/ }).click();
    await expect.poll(order).toEqual([cardKey, aKey]);
    await expect(page).toHaveURL(new RegExp(`/board/${cardId}$`));
    await expect(panel(aKey).getByTestId('panel-from')).toContainText(
      `ZM-${cardNumber}`
    );

    // 2. A memory id in A's text opens B right after A.
    await panel(aKey).getByRole('link', { name: bId }).click();
    await expect.poll(order).toEqual([cardKey, aKey, bKey]);

    // 3. The same link again adds nothing.
    await refs.getByRole('link', { name: /panel-chain A/ }).click();
    await expect.poll(order).toEqual([cardKey, aKey, bKey]);

    // 4. A second link from the card goes right after the card; the rest of
    //    the canvas is kept.
    await refs.getByRole('link', { name: /panel-chain C/ }).click();
    await expect.poll(order).toEqual([cardKey, cKey, aKey, bKey]);

    // 5. A modified click is a real navigation in a new tab, not a panel.
    const [popup] = await Promise.all([
      page.context().waitForEvent('page'),
      refs
        .getByRole('link', { name: /panel-chain C/ })
        .click({ modifiers: ['ControlOrMeta'] }),
    ]);
    await popup.close();
    await expect.poll(order).toEqual([cardKey, cKey, aKey, bKey]);

    // 6. × on A closes A and B, which was opened from it.
    await panel(aKey).getByTestId('panel-close').click();
    await expect.poll(order).toEqual([cardKey, cKey]);

    // 7. An entity chip opens the entity as a panel.
    await refs.getByRole('link', { name: /panel-chain A/ }).click();
    await expect.poll(order).toEqual([cardKey, aKey, cKey]);
    await panel(aKey).getByRole('link', { name: entityName }).click();
    const entityPanel = page.locator('[data-panel-key^="entity:"]');
    await expect(entityPanel.getByTestId('entity-name').first()).toContainText(
      entityName
    );
    const withEntity = await order();
    expect(withEntity).toHaveLength(4);

    // 8. Escape inside a nested dialog closes only that dialog.
    await panel(aKey).getByRole('button', { name: 'Forget' }).click();
    await expect(
      page.getByRole('button', { name: 'Invalidate' })
    ).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('button', { name: 'Invalidate' })).toBeHidden();
    await expect.poll(order).toEqual(withEntity);

    // 9. An action in a panel refreshes that panel.
    await expect(panel(aKey).getByTestId('memory-validity')).toContainText(
      'present'
    );
    await panel(aKey).getByRole('button', { name: 'Forget' }).click();
    await page.getByRole('button', { name: 'Invalidate' }).click();
    await expect(panel(aKey).getByTestId('memory-validity')).not.toContainText(
      'present'
    );

    // 10. Escape unwinds by opening order, then closes the dialog.
    for (let left = (await order()).length; left > 1; left -= 1) {
      await page.keyboard.press('Escape');
      await expect.poll(async () => (await order()).length).toBe(left - 1);
    }
    await expect.poll(order).toEqual([cardKey]);
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('card-modal')).toBeHidden();
    await expect(page).toHaveURL(/\/board(\?[^/]*)?$/);

    // 11. A resource gone by the time it is clicked shows "not available", and
    //     a failed load offers a retry — never a broken panel.
    await openCard();
    await page.route(`**/api/panels/memory/${aId}`, (route) =>
      route.fulfill({
        status: 404,
        contentType: 'application/json',
        body: '{"error":"not_found"}',
      })
    );
    await refs.getByRole('link', { name: /panel-chain A/ }).click();
    await expect(panel(aKey).getByTestId('panel-unavailable')).toBeVisible();
    await page.unroute(`**/api/panels/memory/${aId}`);

    await page.route(`**/api/panels/memory/${cId}`, (route) =>
      route.fulfill({ status: 500, body: 'boom' })
    );
    await refs.getByRole('link', { name: /panel-chain C/ }).click();
    await expect(
      panel(cKey).getByRole('button', { name: 'Retry' })
    ).toBeVisible();
    await page.unroute(`**/api/panels/memory/${cId}`);
    await panel(cKey).getByRole('button', { name: 'Retry' }).click();
    await expect(panel(cKey).getByTestId('memory-content')).toContainText(
      'panel-chain C'
    );

    // 12. A click on the empty space around the panels dismisses the dialog,
    //     as a click outside it always has.
    await page.getByTestId('panel-strip').click({ position: { x: 8, y: 8 } });
    await expect(page.getByTestId('card-modal')).toBeHidden();
    await expect(page).toHaveURL(/\/board(\?[^/]*)?$/);
  });
  test('a card shows the branch its work ran on and where it landed', async ({
    page,
  }) => {
    const seed = await readSeedState();
    const mcp = await McpTestClient.connect(
      await passwordGrantToken(seed.userA)
    );
    let cardId: string;
    let cardNumber: number;
    try {
      const scope = firstJson<{ scope: string }>(
        await mcp.callTool('remember', {
          content: `board-web branch marker ${Date.now()}: page the memory feed`,
          kind: 'fact',
          project_hint: '/tmp/zm-e2e-board-web-branch',
        })
      ).scope;
      const created = firstJson<CardResult>(
        await mcp.callTool('card', {
          action: 'create',
          no_links: 'e2e fixture',
          scope,
          title: 'Page the memory feed',
          state: 'active',
          branch: { repo: 'acme/memory-service', name: 'feature/feed-pages' },
        })
      ).card;
      cardId = created.id;
      cardNumber = created.number;
      const landed = await mcp.callTool('card', {
        action: 'land',
        card_id: cardId,
        branch: { repo: 'acme/memory-service', name: 'feature/feed-pages' },
        squash_sha: '4f11a55',
        target: 'main',
        reason: 'full e2e green; waits for the release',
      });
      expect(landed.isError ?? false).toBe(false);
    } finally {
      await mcp.close();
    }

    await signInThroughForm(page, seed.userA);
    await page.goto(`/board/${cardId}`);
    // One label everywhere: the card is ZM-N here, as in its squash trailer.
    await expect(page.getByTestId('card-detail')).toContainText(
      `ZM-${cardNumber}`
    );
    await expect(page.getByTestId('card-detail')).not.toContainText(
      `#${cardNumber}`
    );
    const branch = page.getByTestId('card-branch');
    await expect(branch).toHaveCount(1);
    await expect(branch).toContainText('feature/feed-pages');
    await expect(branch).toContainText('acme/memory-service');
    await expect(page.getByTestId('card-branch-state')).toContainText(
      '4f11a55'
    );
    await expect(page.getByTestId('card-branch-state')).toContainText('main');
    await expect(page.getByTestId('card-history')).toContainText('landed');
    // Landed once: nothing earlier to show.
    await expect(page.getByTestId('card-branch-earlier')).toHaveCount(0);
  });
  test('a branch that landed again shows its earlier landing beside the latest', async ({
    page,
  }) => {
    const seed = await readSeedState();
    const mcp = await McpTestClient.connect(
      await passwordGrantToken(seed.userA)
    );
    let cardId: string;
    try {
      const scope = firstJson<{ scope: string }>(
        await mcp.callTool('remember', {
          content: `board-web re-landing marker ${Date.now()}: a fix in its own branch`,
          kind: 'fact',
          project_hint: '/tmp/zm-e2e-board-web-reland',
        })
      ).scope;
      cardId = firstJson<CardResult>(
        await mcp.callTool('card', {
          action: 'create',
          no_links: 'e2e fixture',
          scope,
          title: 'Fixed where it began',
          state: 'active',
          branch: { repo: 'acme/memory-service', name: 'feature/relanded' },
        })
      ).card.id;
      for (const [sha, reason] of [
        ['aaaaaaa', 'the feature landed'],
        ['bbbbbbb', 'a bug fixed in the same branch'],
      ]) {
        const landed = await mcp.callTool('card', {
          action: 'land',
          card_id: cardId,
          branch: { repo: 'acme/memory-service', name: 'feature/relanded' },
          squash_sha: sha,
          target: 'main',
          reason,
        });
        expect(landed.isError ?? false).toBe(false);
      }
    } finally {
      await mcp.close();
    }

    await signInThroughForm(page, seed.userA);
    await page.goto(`/board/${cardId}`);
    await expect(page.getByTestId('card-branch')).toHaveCount(1);
    await expect(page.getByTestId('card-branch-state')).toContainText(
      'bbbbbbb'
    );
    const earlier = page.getByTestId('card-branch-earlier');
    await expect(earlier).toContainText('aaaaaaa');
    await expect(earlier).not.toContainText('bbbbbbb');
  });
  test('a card label stays on one line beside a long title', async ({
    page,
  }) => {
    const seed = await readSeedState();
    const mcp = await McpTestClient.connect(
      await passwordGrantToken(seed.userA)
    );
    let scope: string;
    let cardNumber: number;
    try {
      scope = firstJson<{ scope: string }>(
        await mcp.callTool('remember', {
          content: `board-web label marker ${Date.now()}: a card with a long title`,
          kind: 'fact',
          project_hint: '/tmp/zm-e2e-board-web-label',
        })
      ).scope;
      cardNumber = firstJson<CardResult>(
        await mcp.callTool('card', {
          action: 'create',
          no_links: 'e2e fixture',
          scope,
          title:
            'Translate imported memories into the canonical language before ' +
            'they reach the index',
        })
      ).card.number;
    } finally {
      await mcp.close();
    }

    await signInThroughForm(page, seed.userA);
    await page.goto(`/board?scope=${encodeURIComponent(scope)}`);
    const label = page
      .getByTestId('board-column-idea')
      .getByTestId('board-card-number');
    await expect(label).toHaveText(`ZM-${cardNumber}`);
    // A label broken after its hyphen ("ZM-" over "3") is taller than one line.
    expect(
      await label.evaluate(
        (node) =>
          node.getBoundingClientRect().height <
          parseFloat(getComputedStyle(node).lineHeight) * 1.5
      )
    ).toBe(true);
  });
  test('a long card title wraps in its own column beside the label', async ({
    page,
  }) => {
    const seed = await readSeedState();
    const mcp = await McpTestClient.connect(
      await passwordGrantToken(seed.userA)
    );
    let cardId: string;
    try {
      const scope = firstJson<{ scope: string }>(
        await mcp.callTool('remember', {
          content: `board-web header marker ${Date.now()}: a card with a long title`,
          kind: 'fact',
          project_hint: '/tmp/zm-e2e-board-web-header',
        })
      ).scope;
      cardId = firstJson<CardResult>(
        await mcp.callTool('card', {
          action: 'create',
          no_links: 'e2e fixture',
          scope,
          title:
            'Styled scrollbars that do not break the layout under long ' +
            'content, even when the card title runs well past one line',
        })
      ).card.id;
    } finally {
      await mcp.close();
    }

    await signInThroughForm(page, seed.userA);
    await page.setViewportSize({ width: 900, height: 800 });
    await page.goto(`/board/${cardId}`);
    const label = await page.getByTestId('card-number').boundingBox();
    const title = await page.getByTestId('card-title').boundingBox();
    expect(label).not.toBeNull();
    expect(title).not.toBeNull();
    // The title wraps (the case under test) ...
    expect(title!.height).toBeGreaterThan(label!.height * 1.5);
    // ... inside its own column, starting on the label's line: no line holds
    // the label alone, and every wrapped line keeps the label's indent.
    expect(title!.y).toBeLessThan(label!.y + label!.height);
    expect(title!.x).toBeGreaterThanOrEqual(label!.x + label!.width);
  });
  test("a card's label is its link, and a click copies it", async ({
    page,
    context,
  }) => {
    const seed = await readSeedState();
    const mcp = await McpTestClient.connect(
      await passwordGrantToken(seed.userA)
    );
    let cardId: string;
    let cardNumber: number;
    try {
      const scope = firstJson<{ scope: string }>(
        await mcp.callTool('remember', {
          content: `board-web link marker ${Date.now()}: a card whose label is copied`,
          kind: 'fact',
          project_hint: '/tmp/zm-e2e-board-web-link',
        })
      ).scope;
      const created = firstJson<CardResult>(
        await mcp.callTool('card', {
          action: 'create',
          no_links: 'e2e fixture',
          scope,
          title: 'A card to link to',
        })
      ).card;
      cardId = created.id;
      cardNumber = created.number;
    } finally {
      await mcp.close();
    }

    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await signInThroughForm(page, seed.userA);
    await page.goto(`/board/${cardId}`);
    const label = page.getByTestId('card-number');
    await expect(label).toHaveText(`ZM-${cardNumber}`);
    await expect(label).toHaveAttribute('href', `/board/${cardId}`);

    await label.click();
    // A plain click copies the card's full address and stays on the page.
    await expect
      .poll(() => page.evaluate(() => navigator.clipboard.readText()))
      .toBe(new URL(`/board/${cardId}`, page.url()).toString());
    await expect(page).toHaveURL(new RegExp(`/board/${cardId}$`));
    await expect(label).toHaveText(`ZM-${cardNumber}`);
  });

  test('a card shows its relations, and a relation opens the other card beside it', async ({
    page,
  }) => {
    const seed = await readSeedState();
    const stamp = Date.now();
    const mcp = await McpTestClient.connect(
      await passwordGrantToken(seed.userA)
    );
    let scope: string;
    let parent: CardResult['card'];
    let blocker: CardResult['card'];
    let blocked: CardResult['card'];
    let neighbour: CardResult['card'];
    try {
      const anchor = firstJson<{ scope: string; memory_id: string }>(
        await mcp.callTool('remember', {
          content: `card-links web anchor ${stamp}: relations shown on a card`,
          kind: 'decision',
          project_hint: `/tmp/zm-e2e-card-links-web-${stamp}`,
        })
      );
      scope = anchor.scope;
      const create = async (
        title: string,
        declaration: Record<string, unknown>
      ) => {
        const created = await mcp.callTool('card', {
          action: 'create',
          scope,
          title,
          ...declaration,
        });
        expect(created.isError ?? false).toBe(false);
        return firstJson<CardResult>(created).card;
      };
      parent = await create(`relations parent ${stamp}`, {
        no_links: 'e2e fixture',
      });
      blocker = await create(`relations blocker ${stamp}`, {
        no_links: 'e2e fixture',
      });
      blocked = await create(`relations blocked ${stamp}`, {
        links: [
          {
            card: `ZM-${blocker.number}`,
            relation: 'blocked_by',
            reason: 'the blocker ships first',
          },
          {
            card: parent.id,
            relation: 'child_of',
            reason: 'one part of the parent',
          },
        ],
      });
      neighbour = await create(`relations neighbour ${stamp}`, {
        no_links: 'e2e fixture',
      });
      // The old way to point at a card still works, and reads as a relation
      // nobody typed.
      const attached = await mcp.callTool('card_log', {
        action: 'attach',
        card_id: neighbour.id,
        ref_kind: 'card',
        ref_target: blocked.id,
      });
      expect(attached.isError ?? false).toBe(false);
      const memory = await mcp.callTool('card_log', {
        action: 'attach',
        card_id: blocked.id,
        ref_kind: 'memory',
        ref_target: anchor.memory_id,
      });
      expect(memory.isError ?? false).toBe(false);
    } finally {
      await mcp.close();
    }

    await signInThroughForm(page, seed.userA);
    await page.goto(`/board?scope=${encodeURIComponent(scope)}`);
    const tileOf = (title: string) =>
      page.getByTestId('board-card').filter({ hasText: title });
    // A blocked card says so on its tile; the card that blocks it does not.
    await expect(
      tileOf(`relations blocked ${stamp}`).getByTestId('board-card-blocked')
    ).toHaveText('blocked');
    await expect(
      tileOf(`relations blocker ${stamp}`).getByTestId('board-card-blocked')
    ).toHaveCount(0);

    await tileOf(`relations blocked ${stamp}`).click();
    const modal = page.getByTestId('card-modal');
    await expect(modal).toBeVisible();

    // Relations are grouped by side: what is above the card, and what merely
    // relates to it — with the reason each was declared with.
    const section = modal.getByTestId('card-links-section').first();
    const above = section.getByTestId('card-links-group-above');
    await expect(above.getByTestId('card-link')).toHaveCount(2);
    await expect(above).toContainText(`child of ZM-${parent.number}`);
    await expect(above).toContainText(`blocked by ZM-${blocker.number}`);
    await expect(above).toContainText('the blocker ships first');
    const related = section.getByTestId('card-links-group-related');
    await expect(related).toContainText(`relates to ZM-${neighbour.number}`);
    await expect(related).toContainText('type not declared');

    // An attached memory is named by its kind, not as "memory".
    const refs = modal.getByTestId('card-refs').first();
    await expect(refs).toContainText('decision');
    await expect(refs).not.toContainText('memory');

    // The history records each relation from this card's side.
    await expect(modal.getByTestId('card-history').first()).toContainText(
      `blocked by ZM-${blocker.number}`
    );

    // Still a window: nothing here changes a card or a relation.
    const detail = modal.getByTestId('card-detail').first();
    await expect(detail.getByRole('button')).toHaveCount(0);
    await expect(detail.locator('form')).toHaveCount(0);

    // A relation opens the other card as the next panel.
    await above.getByRole('link', { name: `ZM-${blocker.number}` }).click();
    await expect
      .poll(() =>
        page
          .getByTestId('panel')
          .evaluateAll((nodes) =>
            nodes.map((node) => node.getAttribute('data-panel-key'))
          )
      )
      .toEqual([`card:${blocked.id}`, `card:${blocker.id}`]);
    await expect(
      page.locator(`[data-panel-key="card:${blocker.id}"]`)
    ).toContainText(`relations blocker ${stamp}`);
  });
});
