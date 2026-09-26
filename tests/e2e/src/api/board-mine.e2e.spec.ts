/**
 * The board tool lists the cards an agent's owner worked on: the flag reaches
 * the store, and the latest step survives every layer on its way back.
 */
import { expect, test } from '@playwright/test';

import { admin } from '../helpers/board-store.js';
import { firstJson, McpTestClient } from '../helpers/mcp.js';
import { readSeedState } from '../helpers/runtime-state.js';
import { passwordGrantToken } from '../helpers/users.js';

interface Listed {
  number: number;
  my_last?: { type: string; text: string | null };
  past_horizon?: boolean;
}

const markers: string[] = [];

test.afterAll(async () => {
  if (markers.length > 0) {
    await admin().from('memories').delete().in('id', markers);
  }
});

test('the board tool lists the cards I worked on, with my latest step', async () => {
  const seed = await readSeedState();
  const mcp = await McpTestClient.connect(await passwordGrantToken(seed.userA));
  try {
    const made = firstJson<{ scope: string; memory_id: string }>(
      await mcp.callTool('remember', {
        content: `board-mine tool marker ${Date.now()}: the relay drops frames`,
        kind: 'fact',
        project_hint: `/tmp/zm-e2e-board-mine-tool-${Date.now()}`,
      })
    );
    markers.push(made.memory_id);
    const create = async (title: string) =>
      firstJson<{ card: { id: string; number: number } }>(
        await mcp.callTool('card', {
          action: 'create',
          scope: made.scope,
          title,
          no_links: 'e2e fixture',
        })
      ).card;
    const older = await create('Relay keys');
    const newer = await create('Relay rollout');
    const noted = await mcp.callTool('card_log', {
      action: 'note',
      card_id: older.id,
      text: 'keys first',
    });
    expect(noted.isError ?? false).toBe(false);

    const mine = await mcp.callTool('board', {
      action: 'list',
      scope: made.scope,
      worked_by_me: true,
    });
    expect(mine.isError ?? false).toBe(false);
    const cards = firstJson<{ cards: Listed[] }>(mine).cards;
    expect(cards.map((c) => c.number)).toEqual([older.number, newer.number]);
    expect(cards[0]!.my_last).toMatchObject({
      type: 'noted',
      text: 'keys first',
    });
    expect(cards[0]!.past_horizon).toBe(false);

    const plain = firstJson<{ cards: Listed[] }>(
      await mcp.callTool('board', { action: 'list', scope: made.scope })
    ).cards;
    expect(plain.every((c) => c.my_last === undefined)).toBe(true);
  } finally {
    await mcp.close();
  }
});
