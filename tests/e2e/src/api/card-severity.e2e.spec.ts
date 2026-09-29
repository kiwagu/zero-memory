/**
 * A card says how much it matters: a severity from 1 (minimal) to 5 (urgent),
 * normal unless said, changed through `edit` with both levels recorded in
 * the card's history, and read back wherever the card is named — the
 * listing, the card itself and the briefing.
 *
 * Proven here because only the live store can prove it: the default lives in
 * the column, the from/to pair on the event row, and a level outside the
 * scale is refused by the store's own check as much as by the service. What
 * the service refuses before any round trip is its unit tests' to pin.
 */
import { expect, test } from '@playwright/test';

import type { CardResult } from '../helpers/board-store.js';
import { contentText, firstJson, McpTestClient } from '../helpers/mcp.js';
import { readSeedState } from '../helpers/runtime-state.js';
import { passwordGrantToken } from '../helpers/users.js';

interface SeverityCard {
  card: CardResult['card'] & { severity: number; revision: number };
  changed?: boolean;
}

interface BoardRead {
  cards: Array<{ id: string; severity: number }>;
  card: { severity: number; revision: number } | null;
  events: Array<{
    type: string;
    revision: number | null;
    from_severity: number | null;
    to_severity: number | null;
  }>;
}

interface Pack {
  work?: {
    lead: Array<{ id: string; severity?: number }>;
  };
}

test.describe('Card severity over MCP', () => {
  test('a card sits at normal unless said, and an edit records the level it moved from', async () => {
    const seed = await readSeedState();
    const agent = await McpTestClient.connect(
      await passwordGrantToken(seed.userA)
    );
    const hint = `/tmp/zm-e2e-severity-${Date.now()}`;
    try {
      const plain = await agent.callTool('card', {
        action: 'create',
        project_hint: hint,
        title: 'Tidy the importer',
        no_links: 'e2e fixture',
      });
      expect(plain.isError ?? false).toBe(false);
      expect(firstJson<SeverityCard>(plain).card.severity).toBe(3);

      const urgent = await agent.callTool('card', {
        action: 'create',
        project_hint: hint,
        title: 'Hotfix the relay',
        severity: 5,
        no_links: 'e2e fixture',
      });
      expect(urgent.isError ?? false).toBe(false);
      const card = firstJson<SeverityCard>(urgent).card;
      expect(card.severity).toBe(5);

      // The listing carries the level on every row.
      const listed = await agent.callTool('board', {
        action: 'list',
        scope: card.scope,
      });
      expect(listed.isError ?? false).toBe(false);
      const rows = firstJson<BoardRead>(listed).cards;
      expect(rows.find((row) => row.id === card.id)?.severity).toBe(5);

      // An edit of the severity alone bumps the revision, and the history
      // says which levels it moved between.
      const eased = await agent.callTool('card', {
        action: 'edit',
        card_id: card.id,
        severity: 1,
      });
      expect(eased.isError ?? false).toBe(false);
      const after = firstJson<SeverityCard>(eased).card;
      expect(after.severity).toBe(1);
      expect(after.revision).toBe(card.revision + 1);

      const read = await agent.callTool('board', {
        action: 'get',
        card_id: card.id,
      });
      expect(read.isError ?? false).toBe(false);
      const got = firstJson<BoardRead>(read);
      expect(got.card?.severity).toBe(1);
      expect(got.events.find((event) => event.type === 'edited')).toMatchObject(
        { from_severity: 5, to_severity: 1, revision: after.revision }
      );

      // The same level again is not an edit: no revision, no event.
      const same = await agent.callTool('card', {
        action: 'edit',
        card_id: card.id,
        severity: 1,
      });
      expect(same.isError ?? false).toBe(false);
      expect(firstJson<SeverityCard>(same).changed).toBe(false);
    } finally {
      await agent.close();
    }
  });

  test('a level outside the scale is refused, on create and on edit', async () => {
    const seed = await readSeedState();
    const agent = await McpTestClient.connect(
      await passwordGrantToken(seed.userA)
    );
    const hint = `/tmp/zm-e2e-severity-refused-${Date.now()}`;
    try {
      const tooHigh = await agent.callTool('card', {
        action: 'create',
        project_hint: hint,
        title: 'Beyond the scale',
        severity: 6,
        no_links: 'e2e fixture',
      });
      expect(tooHigh.isError).toBe(true);
      expect(contentText(tooHigh)).toMatch(/severity/iu);

      const created = await agent.callTool('card', {
        action: 'create',
        project_hint: hint,
        title: 'On the scale',
        no_links: 'e2e fixture',
      });
      expect(created.isError ?? false).toBe(false);
      const card = firstJson<SeverityCard>(created).card;

      const tooLow = await agent.callTool('card', {
        action: 'edit',
        card_id: card.id,
        severity: 0,
      });
      expect(tooLow.isError).toBe(true);
      expect(contentText(tooLow)).toMatch(/severity/iu);

      // The card is untouched by the refusals.
      const read = await agent.callTool('board', {
        action: 'get',
        card_id: card.id,
      });
      expect(firstJson<BoardRead>(read).card).toMatchObject({
        severity: 3,
        revision: card.revision,
      });
    } finally {
      await agent.close();
    }
  });

  test('a briefing names the level, so a new session can tell an urgent card from the rest', async () => {
    const seed = await readSeedState();
    const agent = await McpTestClient.connect(
      await passwordGrantToken(seed.userA)
    );
    const hint = `/tmp/zm-e2e-severity-brief-${Date.now()}`;
    try {
      const created = await agent.callTool('card', {
        action: 'create',
        project_hint: hint,
        title: 'Hotfix the relay',
        severity: 5,
        state: 'active',
        no_branch: 'an e2e fixture card with no code',
        no_links: 'e2e fixture',
      });
      expect(created.isError ?? false).toBe(false);
      const card = firstJson<SeverityCard>(created).card;

      const briefed = await agent.callTool('build_context', {
        topic: 'the relay',
        briefing: true,
        max_tokens: 1200,
        project_hint: hint,
      });
      expect(briefed.isError ?? false).toBe(false);
      const pack = firstJson<Pack>(briefed);
      expect(
        pack.work?.lead.find((lead) => lead.id === card.id)?.severity
      ).toBe(5);
    } finally {
      await agent.close();
    }
  });
});
