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
      const card = firstJson<{ card: { id: string; number: number } }>(
        promoted
      ).card;
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

    // The card: its work, its attachments, its history.
    await tile.click();
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
  });
});
