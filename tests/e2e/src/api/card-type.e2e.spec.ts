/**
 * A card says why its work exists — story, bug, task or spike — and the store
 * holds it to that: every new card declares a type, a card that predates
 * types declares one when it is picked up, a move only declares and an edit
 * changes, and every read names it. A landed bug suggests keeping what it
 * taught.
 *
 * Proven here because only the live store can prove it: the refusal of a
 * card with no type is the store's own as much as the service's, a card with
 * no type exists only in rows written before the column, and the history
 * pair lives on the event row. What the service refuses before any round
 * trip is its unit tests' to pin.
 */
import { expect, test } from '@playwright/test';

import { asUser, psql, type CardResult } from '../helpers/board-store.js';
import { contentText, firstJson, McpTestClient } from '../helpers/mcp.js';
import { readSeedState } from '../helpers/runtime-state.js';
import { passwordGrantToken } from '../helpers/users.js';

type CardType = 'story' | 'bug' | 'task' | 'spike';

interface TypedCard {
  card: CardResult['card'] & {
    type: CardType | null;
    state: string;
    revision: number;
  };
  changed?: boolean;
  hint?: string | null;
}

interface BoardRead {
  cards: Array<{ id: string; type: CardType | null }>;
  card: { type: CardType | null; revision: number } | null;
  events: Array<{
    type: string;
    revision: number | null;
    from_card_type: CardType | null;
    to_card_type: CardType | null;
  }>;
}

interface Pack {
  work?: { lead: Array<{ id: string; type?: CardType | null }> };
}

const REPO = 'acme/widgets';

test.describe('Card type over MCP', () => {
  test('a new card says why its work exists, before its relations, and every read names it', async () => {
    const seed = await readSeedState();
    const token = await passwordGrantToken(seed.userA);
    const agent = await McpTestClient.connect(token);
    const hint = `/tmp/zm-e2e-type-${Date.now()}`;
    try {
      // Neither a type nor relations: the type is asked for first.
      const bare = await agent.callTool('card', {
        action: 'create',
        project_hint: hint,
        title: 'Tidy the importer',
      });
      expect(bare.isError).toBe(true);
      expect(contentText(bare)).toMatch(/story, bug, task or spike/u);
      expect(contentText(bare)).not.toMatch(/no_links/u);

      const created = await agent.callTool('card', {
        action: 'create',
        project_hint: hint,
        title: 'The importer drops the last row',
        type: 'bug',
        no_links: 'e2e fixture',
      });
      expect(created.isError ?? false).toBe(false);
      const card = firstJson<TypedCard>(created).card;
      expect(card.type).toBe('bug');

      // The store refuses on its own, not only behind the service.
      const { error: storeRefusal, data: storeAnswer } = await asUser(
        token
      ).rpc('card_create', {
        p_scope: card.scope,
        p_title: 'Straight to the store',
        p_no_links: 'e2e fixture',
      });
      expect(storeRefusal).toBeNull();
      expect(storeAnswer).toMatchObject({ error: 'type_required' });

      const listed = firstJson<BoardRead>(
        await agent.callTool('board', { action: 'list', scope: card.scope })
      );
      expect(listed.cards.find((row) => row.id === card.id)?.type).toBe('bug');
      const read = firstJson<BoardRead>(
        await agent.callTool('board', { action: 'get', card_id: card.id })
      );
      expect(read.card?.type).toBe('bug');
    } finally {
      await agent.close();
    }
  });

  test('a card that predates types reads as not declared, and declares one when it is picked up', async () => {
    const seed = await readSeedState();
    const agent = await McpTestClient.connect(
      await passwordGrantToken(seed.userA)
    );
    const hint = `/tmp/zm-e2e-type-legacy-${Date.now()}`;
    try {
      const created = await agent.callTool('card', {
        action: 'create',
        project_hint: hint,
        title: 'Rotate the edge certificates',
        type: 'task',
        no_links: 'e2e fixture',
      });
      expect(created.isError ?? false).toBe(false);
      const card = firstJson<TypedCard>(created).card;
      // What every card written before the column looks like.
      psql(`update public.cards set type = null where id = '${card.id}'`);

      const before = firstJson<BoardRead>(
        await agent.callTool('board', { action: 'get', card_id: card.id })
      );
      expect(before.card?.type).toBeNull();

      // Nothing but entering active asks for it.
      const edited = await agent.callTool('card', {
        action: 'edit',
        card_id: card.id,
        body: 'Both edges, staging first.',
      });
      expect(edited.isError ?? false).toBe(false);
      const parked = await agent.callTool('card', {
        action: 'move',
        card_id: card.id,
        to: 'waiting',
        reason: 'waits for the maintenance window',
      });
      expect(parked.isError ?? false).toBe(false);

      const unsaid = await agent.callTool('card', {
        action: 'move',
        card_id: card.id,
        to: 'active',
        reason: 'the window opened',
        no_branch: 'an ops change with no code',
      });
      expect(unsaid.isError).toBe(true);
      expect(contentText(unsaid)).toMatch(/story, bug, task or spike/u);

      const picked = await agent.callTool('card', {
        action: 'move',
        card_id: card.id,
        to: 'active',
        reason: 'the window opened',
        no_branch: 'an ops change with no code',
        type: 'task',
      });
      expect(picked.isError ?? false).toBe(false);
      const declared = firstJson<TypedCard>(picked).card;
      expect(declared.type).toBe('task');
      // Declaring a type is a change of content: it bumps the revision, so a
      // writer that read the card before still gets a conflict, not a silent
      // overwrite of the declared type.
      const seen = firstJson<TypedCard>(edited).card.revision;
      expect(declared.revision).toBe(seen + 1);
      const stale = await agent.callTool('card', {
        action: 'edit',
        card_id: card.id,
        type: 'story',
        expected_revision: seen,
      });
      expect(stale.isError).toBe(true);
      expect(contentText(stale)).toMatch(/moved on|conflict/iu);
      const after = firstJson<BoardRead>(
        await agent.callTool('board', { action: 'get', card_id: card.id })
      );
      expect(
        after.events.filter((event) => event.to_card_type !== null)
      ).toEqual([
        expect.objectContaining({
          type: 'moved',
          from_card_type: null,
          to_card_type: 'task',
        }),
      ]);

      // A move declares; it never changes a declared type. The same type
      // again is no change at all.
      const retyped = await agent.callTool('card', {
        action: 'move',
        card_id: card.id,
        to: 'waiting',
        reason: 'staging is done',
        type: 'bug',
      });
      expect(retyped.isError).toBe(true);
      expect(contentText(retyped)).toMatch(/edit/u);
      const restated = await agent.callTool('card', {
        action: 'move',
        card_id: card.id,
        to: 'waiting',
        reason: 'staging is done',
        type: 'task',
      });
      expect(restated.isError ?? false).toBe(false);
      expect(firstJson<TypedCard>(restated).card.type).toBe('task');
    } finally {
      await agent.close();
    }
  });

  test('a card that predates types and is already active is noted, attached and landed without one', async () => {
    const seed = await readSeedState();
    const agent = await McpTestClient.connect(
      await passwordGrantToken(seed.userA)
    );
    const hint = `/tmp/zm-e2e-type-legacy-active-${Date.now()}`;
    try {
      const created = await agent.callTool('card', {
        action: 'create',
        project_hint: hint,
        title: 'Retry the relay handshake',
        type: 'bug',
        state: 'active',
        branch: { repo: REPO, name: 'fix/relay-handshake' },
        no_links: 'e2e fixture',
      });
      expect(created.isError ?? false).toBe(false);
      const card = firstJson<TypedCard>(created).card;
      psql(`update public.cards set type = null where id = '${card.id}'`);

      const noted = await agent.callTool('card_log', {
        action: 'note',
        card_id: card.id,
        text: 'The retry covers the first handshake only.',
      });
      expect(noted.isError ?? false).toBe(false);
      const attached = await agent.callTool('card_log', {
        action: 'attach',
        card_id: card.id,
        ref_kind: 'url',
        ref_target: 'https://example.com/relay-handshake',
      });
      expect(attached.isError ?? false).toBe(false);
      const landed = await agent.callTool('card', {
        action: 'land',
        card_id: card.id,
        branch: { repo: REPO, name: 'fix/relay-handshake' },
        squash_sha: 'abcdef2',
        target: 'main',
        reason: 'gate green; waits for the release',
      });
      expect(landed.isError ?? false).toBe(false);
      const after = firstJson<TypedCard>(landed);
      expect(after.card).toMatchObject({ state: 'waiting', type: null });
      // No type, so nothing to suggest about a bug.
      expect(after.hint).toBeNull();
    } finally {
      await agent.close();
    }
  });

  test('an edit changes the type, and the history says what it replaced', async () => {
    const seed = await readSeedState();
    const agent = await McpTestClient.connect(
      await passwordGrantToken(seed.userA)
    );
    const hint = `/tmp/zm-e2e-type-edit-${Date.now()}`;
    try {
      const created = await agent.callTool('card', {
        action: 'create',
        project_hint: hint,
        title: 'Search feels slow',
        type: 'story',
        no_links: 'e2e fixture',
      });
      const card = firstJson<TypedCard>(created).card;

      const retyped = await agent.callTool('card', {
        action: 'edit',
        card_id: card.id,
        type: 'bug',
      });
      expect(retyped.isError ?? false).toBe(false);
      const after = firstJson<TypedCard>(retyped).card;
      expect(after).toMatchObject({ type: 'bug', revision: card.revision + 1 });
      const read = firstJson<BoardRead>(
        await agent.callTool('board', { action: 'get', card_id: card.id })
      );
      expect(
        read.events.find((event) => event.type === 'edited')
      ).toMatchObject({
        from_card_type: 'story',
        to_card_type: 'bug',
        revision: after.revision,
      });

      const same = await agent.callTool('card', {
        action: 'edit',
        card_id: card.id,
        type: 'bug',
      });
      expect(firstJson<TypedCard>(same).changed).toBe(false);
    } finally {
      await agent.close();
    }
  });

  test('a landed bug suggests keeping what it taught, and other work does not', async () => {
    const seed = await readSeedState();
    const agent = await McpTestClient.connect(
      await passwordGrantToken(seed.userA)
    );
    const hint = `/tmp/zm-e2e-type-land-${Date.now()}`;
    try {
      const land = async (type: CardType, branch: string) => {
        const created = await agent.callTool('card', {
          action: 'create',
          project_hint: hint,
          title: `Land a ${type}`,
          type,
          state: 'active',
          branch: { repo: REPO, name: branch },
          no_links: 'e2e fixture',
        });
        expect(created.isError ?? false).toBe(false);
        const landed = await agent.callTool('card', {
          action: 'land',
          card_id: firstJson<TypedCard>(created).card.id,
          branch: { repo: REPO, name: branch },
          squash_sha: 'abcdef1',
          target: 'main',
          reason: 'gate green; waits for the release',
        });
        expect(landed.isError ?? false).toBe(false);
        return firstJson<TypedCard>(landed).hint;
      };

      expect(await land('bug', 'fix/last-row')).toMatch(/gotcha/u);
      expect(await land('story', 'feature/bulk-import')).toBeNull();
    } finally {
      await agent.close();
    }
  });

  test('a briefing names the type, so a new session knows how to take the card up', async () => {
    const seed = await readSeedState();
    const agent = await McpTestClient.connect(
      await passwordGrantToken(seed.userA)
    );
    const hint = `/tmp/zm-e2e-type-brief-${Date.now()}`;
    try {
      const created = await agent.callTool('card', {
        action: 'create',
        project_hint: hint,
        title: 'The relay drops messages',
        type: 'bug',
        state: 'active',
        no_branch: 'an e2e fixture card with no code',
        no_links: 'e2e fixture',
      });
      const card = firstJson<TypedCard>(created).card;

      const pack = firstJson<Pack>(
        await agent.callTool('build_context', {
          topic: 'the relay',
          briefing: true,
          max_tokens: 1200,
          project_hint: hint,
        })
      );
      expect(pack.work?.lead.find((lead) => lead.id === card.id)?.type).toBe(
        'bug'
      );
    } finally {
      await agent.close();
    }
  });
});
