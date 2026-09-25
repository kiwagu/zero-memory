/**
 * Relations between cards through the MCP tools an agent calls: the `card`
 * tool links, unlinks and asks for relations when a card is made; the `board`
 * tool reads them from both sides and narrows the board to what sits above or
 * below a card.
 */
import { expect, test } from '@playwright/test';

import { contentText, firstJson, McpTestClient } from '../helpers/mcp.js';
import { readSeedState } from '../helpers/runtime-state.js';
import { passwordGrantToken } from '../helpers/users.js';

interface CardResult {
  card: { id: string; number: number; scope: string };
  candidates?: Array<{ number: number; why: string }>;
}

interface BoardGet {
  links: Array<{ card_id: string; number: number; relation: string }>;
  blocked: boolean;
}

interface BoardList {
  cards: Array<{ id: string; blocked: boolean; links: number }>;
}

test.describe('Card relations over MCP', () => {
  test('an agent states relations, links by label and reads both sides', async () => {
    const seed = await readSeedState();
    const mcp = await McpTestClient.connect(
      await passwordGrantToken(seed.userA)
    );
    try {
      const anchor = await mcp.callTool('remember', {
        content: `card-relations anchor ${Date.now()}: the relay needs keys`,
        kind: 'fact',
        project_hint: `/tmp/zm-e2e-card-relations-${Date.now()}`,
      });
      const scope = firstJson<{ scope: string }>(anchor).scope;

      // A new card without a statement about its relations is refused, and
      // the refusal names what on the board looks related.
      const keys = firstJson<CardResult>(
        await mcp.callTool('card', {
          action: 'create',
          scope,
          title: 'Rotate the relay keys',
          no_links: 'the first card of this board',
        })
      ).card;
      const bare = await mcp.callTool('card', {
        action: 'create',
        scope,
        title: 'Ship the relay once the keys rotate',
      });
      expect(bare.isError).toBe(true);
      expect(contentText(bare)).toMatch(/links|no_links/u);
      expect(contentText(bare)).toContain(`ZM-${keys.number}`);

      const ship = firstJson<CardResult>(
        await mcp.callTool('card', {
          action: 'create',
          scope,
          title: 'Ship the relay',
          links: [
            {
              card: `ZM-${keys.number}`,
              relation: 'blocked_by',
              reason: 'old keys cannot ship',
            },
          ],
        })
      ).card;

      const read = firstJson<BoardGet>(
        await mcp.callTool('board', { action: 'get', card_id: ship.id })
      );
      expect(read.blocked).toBe(true);
      expect(read.links).toEqual([
        expect.objectContaining({ card_id: keys.id, relation: 'blocked_by' }),
      ]);

      const docs = firstJson<CardResult>(
        await mcp.callTool('card', {
          action: 'create',
          scope,
          title: 'Relay docs',
          no_links: 'docs start alone',
        })
      ).card;
      const linked = await mcp.callTool('card', {
        action: 'link',
        card_id: docs.id,
        to_card: `ZM-${ship.number}`,
        relation: 'relates_to',
        reason: 'documents the rollout',
      });
      expect(linked.isError ?? false).toBe(false);

      const above = firstJson<BoardList>(
        await mcp.callTool('board', {
          action: 'list',
          scope,
          related_to: `ZM-${ship.number}`,
          relation_filter: 'above',
        })
      );
      expect(above.cards.map((card) => card.id)).toEqual([keys.id]);

      const unlinked = await mcp.callTool('card', {
        action: 'unlink',
        card_id: ship.id,
        to_card: keys.id,
        relation: 'blocked_by',
        reason: 'keys rotated',
      });
      expect(unlinked.isError ?? false).toBe(false);
      expect(
        firstJson<BoardGet>(
          await mcp.callTool('board', { action: 'get', card_id: ship.id })
        ).blocked
      ).toBe(false);
    } finally {
      await mcp.close();
    }
  });
});
