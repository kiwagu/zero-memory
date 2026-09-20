/**
 * The project board end to end: a loop outgrows a one-line handover and
 * becomes a card, the card carries its work forward with a reason on every
 * move, and what another agent left on it is readable without being binding.
 *
 * The invariants proven here are the ones the board would be worthless
 * without: a move cannot happen without a stated reason, a retry after a
 * timeout lands once, a note never moves the card, promoting a loop does not
 * close it, and a stranger sees nothing at all.
 */
import { expect, test } from '@playwright/test';

import { contentText, firstJson, McpTestClient } from '../helpers/mcp.js';
import { readSeedState } from '../helpers/runtime-state.js';
import { passwordGrantToken } from '../helpers/users.js';

interface CardRow {
  id: string;
  scope: string;
  number: number;
  title: string;
  state: string;
  revision: number;
  origin_loop_id: string | null;
  archived_at: string | null;
}

interface CardResult {
  card: CardRow;
  changed: boolean;
  replayed: boolean;
}

interface BoardResult {
  cards: Array<{ id: string; number: number; state: string; refs: number }>;
  totals: Record<string, number>;
  card: CardRow | null;
  refs: Array<{
    kind: string;
    target: string;
    available: boolean;
    preview: string | null;
  }>;
  events: Array<{
    id: string;
    seq: number;
    type: string;
    reason: string | null;
    text: string | null;
    to_state: string | null;
  }>;
  has_more: boolean;
  next_after_seq: number;
}

const PROJECT_HINT = '/tmp/zm-e2e-board-project';

test.describe('Project board over MCP', () => {
  test('a loop becomes a card that carries its work with a reason on every move', async () => {
    const seed = await readSeedState();
    const token = await passwordGrantToken(seed.userA);
    const agent = await McpTestClient.connect(token);
    try {
      // A handover that outgrew a loop: it is the seed of a piece of work.
      const remembered = await agent.callTool('remember', {
        content:
          'e2e board marker: migrate the ingest worker off the legacy queue ' +
          '— pointer /shares/zm/ingest-migration.md, three stages still open',
        kind: 'task',
        project_hint: PROJECT_HINT,
      });
      expect(remembered.isError ?? false).toBe(false);
      const loop = firstJson<{ memory_id: string; scope: string }>(remembered);

      // 1. Promoting the loop opens a card and records where it came from.
      const promoted = await agent.callTool('card', {
        action: 'promote_loop',
        loop_id: loop.memory_id,
        title: 'Migrate the ingest worker off the legacy queue',
        body: 'Goal: no traffic on the legacy queue.\nBoundaries: no schema change.',
      });
      expect(promoted.isError ?? false).toBe(false);
      const card = firstJson<CardResult>(promoted).card;
      expect(card.origin_loop_id).toBe(loop.memory_id);
      expect(card.number).toBeGreaterThan(0);
      expect(card.state).toBe('active');

      // A loop promotes into exactly one card, however often it is asked.
      const twice = await agent.callTool('card', {
        action: 'promote_loop',
        loop_id: loop.memory_id,
        title: 'Second attempt at the same work',
      });
      expect(twice.isError ?? false).toBe(true);

      // 2. A move without a reason is refused — there is no way around it.
      const reasonless = await agent.callTool('card', {
        action: 'move',
        card_id: card.id,
        to: 'waiting',
        reason: '   ',
      });
      expect(reasonless.isError ?? false).toBe(true);
      expect(contentText(reasonless)).toMatch(/reason/i);

      // ...and a move to the state it is already in says so rather than
      // writing a second identical row.
      const standstill = await agent.callTool('card', {
        action: 'move',
        card_id: card.id,
        to: 'active',
        reason: 'no change, just checking',
      });
      expect(standstill.isError ?? false).toBe(true);

      const moved = await agent.callTool('card', {
        action: 'move',
        card_id: card.id,
        to: 'waiting',
        reason: 'blocked on the owner picking a cutover window',
      });
      expect(moved.isError ?? false).toBe(false);
      expect(firstJson<CardResult>(moved).card.state).toBe('waiting');

      // 3. A note is a statement, not a verdict: it does not move the card.
      const noted = await agent.callTool('card_log', {
        action: 'note',
        card_id: card.id,
        text: 'I consider this finished from my side.',
        idempotency_key: 'e2e-board-note-1',
      });
      expect(noted.isError ?? false).toBe(false);
      const noteId = firstJson<{ event_id: string }>(noted).event_id;

      // The same key again replays instead of writing a second note.
      const replay = await agent.callTool('card_log', {
        action: 'note',
        card_id: card.id,
        text: 'I consider this finished from my side.',
        idempotency_key: 'e2e-board-note-1',
      });
      expect(replay.isError ?? false).toBe(false);
      expect(firstJson<{ replayed: boolean }>(replay).replayed).toBe(true);

      // A relation needs the note it answers.
      const orphan = await agent.callTool('card_log', {
        action: 'note',
        card_id: card.id,
        text: 'not so fast',
        relation: 'disputes',
      });
      expect(orphan.isError ?? false).toBe(true);

      const answered = await agent.callTool('card_log', {
        action: 'note',
        card_id: card.id,
        text: 'The cutover window is not picked yet, so it is not finished.',
        reply_to: noteId,
        relation: 'disputes',
      });
      expect(answered.isError ?? false).toBe(false);

      // 4. Attaching points at an artifact and is idempotent.
      const attached = await agent.callTool('card_log', {
        action: 'attach',
        card_id: card.id,
        ref_kind: 'memory',
        ref_target: loop.memory_id,
      });
      expect(attached.isError ?? false).toBe(false);
      expect(firstJson<{ changed: boolean }>(attached).changed).toBe(true);

      const again = await agent.callTool('card_log', {
        action: 'attach',
        card_id: card.id,
        ref_kind: 'memory',
        ref_target: loop.memory_id,
      });
      expect(firstJson<{ changed: boolean }>(again).changed).toBe(false);

      // 5. Reading the card gives the work, its artifacts and its history.
      const read = await agent.callTool('board', {
        action: 'get',
        card_id: card.id,
      });
      expect(read.isError ?? false).toBe(false);
      const view = firstJson<BoardResult>(read);
      expect(view.card?.state).toBe('waiting');
      expect(view.refs).toHaveLength(1);
      expect(view.refs[0]!.available).toBe(true);
      expect(view.refs[0]!.preview).toContain('e2e board marker');

      const types = view.events.map((event) => event.type);
      expect(types[0]).toBe('created');
      expect(types).toContain('moved');
      expect(types).toContain('noted');
      expect(types).toContain('attached');
      const move = view.events.find((event) => event.type === 'moved');
      expect(move?.reason).toContain('cutover window');
      // The stream is ordered and gapless from the caller's cursor.
      expect(view.events.map((event) => event.seq)).toEqual(
        [...view.events].map((_, index) => index + 1)
      );

      // A cursor returns only what is new.
      const tail = await agent.callTool('board', {
        action: 'get',
        card_id: card.id,
        after_seq: view.next_after_seq,
      });
      expect(firstJson<BoardResult>(tail).events).toHaveLength(0);

      // 6. The board shows the card with its last event and live totals.
      const board = await agent.callTool('board', {
        action: 'list',
        scope: loop.scope,
      });
      expect(board.isError ?? false).toBe(false);
      const listed = firstJson<BoardResult>(board);
      expect(listed.cards.some((row) => row.id === card.id)).toBe(true);
      expect(listed.totals.waiting).toBeGreaterThanOrEqual(1);

      // ...and a project-local number resolves inside its scope.
      const resolved = await agent.callTool('board', {
        action: 'resolve',
        scope: loop.scope,
        number: card.number,
      });
      expect(firstJson<BoardResult>(resolved).card?.id).toBe(card.id);

      // 7. Closing the ORIGIN LOOP must not touch the card: the work was
      // handed over, not finished, and memory hygiene does not run the board.
      const closed = await agent.callTool('close_loop', {
        memory_id: loop.memory_id,
      });
      expect(closed.isError ?? false).toBe(false);

      const afterClose = await agent.callTool('board', {
        action: 'get',
        card_id: card.id,
      });
      const still = firstJson<BoardResult>(afterClose);
      expect(still.card?.state).toBe('waiting');
      expect(still.card?.archived_at).toBeNull();
      expect(still.card?.origin_loop_id).toBe(loop.memory_id);

      // 8. Archiving is terminal and, like every move, needs a reason.
      expect(
        (
          await agent.callTool('card', {
            action: 'archive',
            card_id: card.id,
            reason: '',
          })
        ).isError ?? false
      ).toBe(true);

      const archived = await agent.callTool('card', {
        action: 'archive',
        card_id: card.id,
        reason: 'folded into the platform epic',
      });
      expect(archived.isError ?? false).toBe(false);

      const afterArchive = await agent.callTool('card', {
        action: 'move',
        card_id: card.id,
        to: 'active',
        reason: 'changed my mind',
      });
      expect(afterArchive.isError ?? false).toBe(true);
      expect(contentText(afterArchive)).toMatch(/archiv/i);
    } finally {
      await agent.close();
    }
  });

  test('a card is invisible outside its scope, and its history with it', async () => {
    const seed = await readSeedState();
    const owner = await McpTestClient.connect(
      await passwordGrantToken(seed.userA)
    );
    const stranger = await McpTestClient.connect(
      await passwordGrantToken(seed.userB)
    );
    try {
      // Deliberately NOT a `reference` memory: the advanced-search web spec
      // relies on that kind being absent from the corpus, and a fixture here
      // would break a test three directories away.
      const remembered = await owner.callTool('remember', {
        content:
          'e2e board isolation marker: the cutover checklist lives in the ' +
          'private runbook',
        kind: 'fact',
        project_hint: PROJECT_HINT,
      });
      const scope = firstJson<{ scope: string }>(remembered).scope;

      const created = await owner.callTool('card', {
        action: 'create',
        scope,
        title: 'Private work nobody else should see',
        body: 'Contains the cutover checklist.',
      });
      expect(created.isError ?? false).toBe(false);
      const card = firstJson<CardResult>(created).card;

      // The stranger is a real, authenticated user of the same instance.
      const peek = await stranger.callTool('board', {
        action: 'get',
        card_id: card.id,
      });
      expect(peek.isError ?? false).toBe(true);
      expect(contentText(peek)).not.toContain('cutover checklist');

      const listed = await stranger.callTool('board', {
        action: 'list',
        scope,
      });
      expect(firstJson<BoardResult>(listed).cards).toHaveLength(0);

      // Writing into someone else's scope is refused, not silently dropped.
      const write = await stranger.callTool('card_log', {
        action: 'note',
        card_id: card.id,
        text: 'hello from outside',
      });
      expect(write.isError ?? false).toBe(true);

      const untouched = await owner.callTool('board', {
        action: 'get',
        card_id: card.id,
      });
      expect(firstJson<BoardResult>(untouched).events).toHaveLength(1);
    } finally {
      await owner.close();
      await stranger.close();
    }
  });
});
