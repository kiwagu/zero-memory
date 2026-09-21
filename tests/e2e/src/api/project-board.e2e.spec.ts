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
import { createClient } from '@supabase/supabase-js';

import { e2eEnv } from '../helpers/env.js';
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
  feed: Array<{
    memory_id: string;
    kind: string;
    preview: string;
    thread: string;
  }>;
  feed_has_more: boolean;
  feed_next_before: string | null;
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

  test('a conversation bound to a card fills its feed, and nothing else does', async () => {
    const seed = await readSeedState();
    const agent = await McpTestClient.connect(
      await passwordGrantToken(seed.userA)
    );
    const elsewhere = await McpTestClient.connect(
      await passwordGrantToken(seed.userA)
    );
    // A fresh project per run: a memory repeated across runs would be merged
    // into the earlier run's row — born in an earlier conversation.
    const hint = `/tmp/zm-e2e-board-feed-${Date.now()}`;
    const feedOf = async (
      cardId: string,
      extra: Record<string, unknown> = {}
    ): Promise<BoardResult> => {
      const read = await agent.callTool('board', {
        action: 'get',
        card_id: cardId,
        ...extra,
      });
      expect(read.isError ?? false).toBe(false);
      return firstJson<BoardResult>(read);
    };
    const ids = (view: BoardResult): string[] =>
      view.feed.map((item) => item.memory_id);
    const remember = async (
      client: McpTestClient,
      args: Record<string, unknown>
    ): Promise<{ memory_id: string; scope: string }> => {
      const stored = await client.callTool('remember', args);
      expect(stored.isError ?? false).toBe(false);
      return firstJson<{ memory_id: string; scope: string }>(stored);
    };

    try {
      // Reading first opens the conversation this agent's writes are born in.
      const pack = firstJson<{ session?: { thread?: string } }>(
        await agent.callTool('build_context', {
          topic: 'derived card feed',
          briefing: true,
          project_hint: hint,
        })
      );
      const thread = pack.session?.thread;
      expect(thread).toMatch(/^thr_/u);

      // Written BEFORE the conversation is bound: the feed is derived from
      // where a memory was born, not from when the binding happened.
      const early = await remember(agent, {
        content:
          'e2e feed marker: the nightly export runs after the vacuum, never ' +
          'before it',
        kind: 'fact',
        project_hint: hint,
      });

      const created = await agent.callTool('card', {
        action: 'create',
        scope: early.scope,
        title: 'Keep the nightly jobs from colliding',
      });
      expect(created.isError ?? false).toBe(false);
      const card = firstJson<CardResult>(created).card;

      // Nothing is bound yet, so nothing belongs to the card.
      expect((await feedOf(card.id)).feed).toHaveLength(0);

      const bound = await agent.callTool('card_log', {
        action: 'attach',
        card_id: card.id,
        ref_kind: 'thread',
        ref_target: thread,
      });
      expect(bound.isError ?? false).toBe(false);

      const late = await remember(agent, {
        content:
          'e2e feed marker: the backup window moved to four in the morning ' +
          'so it no longer overlaps the report build',
        kind: 'decision',
        project_hint: hint,
      });
      // Same conversation, another scope: a personal note is not the card's.
      const personal = await remember(agent, {
        content: 'e2e feed marker: I prefer reading job logs oldest line first',
        kind: 'preference',
        scope: 'personal',
      });
      // Same project, another conversation: not bound, so not the card's.
      const other = firstJson<{ session?: { thread?: string } }>(
        await elsewhere.callTool('build_context', {
          topic: 'unrelated work',
          briefing: true,
          project_hint: hint,
        })
      );
      expect(other.session?.thread).not.toBe(thread);
      const unrelated = await remember(elsewhere, {
        content:
          'e2e feed marker: the staging certificate renews on the first of ' +
          'the month',
        kind: 'fact',
        project_hint: hint,
      });

      // THE CLAIM: both memories of the bound conversation arrive, newest
      // first, with no attach call for either — and nothing else does.
      const filled = await feedOf(card.id);
      expect(ids(filled)).toEqual([late.memory_id, early.memory_id]);
      expect(filled.feed.every((item) => item.thread === thread)).toBe(true);
      expect(ids(filled)).not.toContain(personal.memory_id);
      expect(ids(filled)).not.toContain(unrelated.memory_id);
      expect(filled.feed[0]?.preview).toContain('backup window');

      // The feed pages on its own cursor, newest to oldest.
      const first = await feedOf(card.id, { limit: 1 });
      expect(ids(first)).toEqual([late.memory_id]);
      expect(first.feed_has_more).toBe(true);
      expect(first.feed_next_before).toBe(late.memory_id);
      const second = await feedOf(card.id, {
        limit: 1,
        feed_before: first.feed_next_before,
      });
      expect(ids(second)).toEqual([early.memory_id]);
      expect(second.feed_has_more).toBe(false);

      // Reading the feed is not a recall: nothing was reinforced by it.
      const admin = createClient(
        e2eEnv.supabaseUrl,
        e2eEnv.supabaseServiceRoleKey,
        { auth: { persistSession: false, autoRefreshToken: false } }
      );
      const { count } = await admin
        .from('usage_events')
        .select('id', { count: 'exact', head: true })
        .eq('event_type', 'recall_used')
        .in('metadata->>mem_id', [early.memory_id, late.memory_id]);
      expect(count ?? 0).toBe(0);

      // A memory attached on purpose is listed once — as an attachment.
      const pinned = await agent.callTool('card_log', {
        action: 'attach',
        card_id: card.id,
        ref_kind: 'memory',
        ref_target: late.memory_id,
      });
      expect(pinned.isError ?? false).toBe(false);
      const withPin = await feedOf(card.id);
      expect(ids(withPin)).toEqual([early.memory_id]);
      expect(withPin.refs.map((ref) => ref.target)).toContain(late.memory_id);

      // A retired memory leaves the feed on its own, and comes back with it.
      const forgotten = await agent.callTool('forget', {
        memory_id: early.memory_id,
      });
      expect(forgotten.isError ?? false).toBe(false);
      expect((await feedOf(card.id)).feed).toHaveLength(0);
      const restored = await agent.callTool('restore_memory', {
        memory_id: early.memory_id,
      });
      expect(restored.isError ?? false).toBe(false);
      expect(ids(await feedOf(card.id))).toEqual([early.memory_id]);

      // Unbinding the conversation is the whole undo: nothing was copied.
      const unbound = await agent.callTool('card_log', {
        action: 'detach',
        card_id: card.id,
        ref_kind: 'thread',
        ref_target: thread,
      });
      expect(unbound.isError ?? false).toBe(false);
      expect((await feedOf(card.id)).feed).toHaveLength(0);
    } finally {
      await agent.close();
      await elsewhere.close();
    }
  });

  test('a briefing names the board work and reaches attached loops through their card', async () => {
    const seed = await readSeedState();
    const agent = await McpTestClient.connect(
      await passwordGrantToken(seed.userA)
    );
    const stamp = Date.now();
    const hint = `/tmp/zm-e2e-board-brief-${stamp}`;
    const bareHint = `/tmp/zm-e2e-board-bare-${stamp}`;

    interface Pack {
      memories: Array<{ id: string }>;
      open_loops: Array<{ id: string }>;
      open_loops_total: number;
      work?: {
        bound_card: {
          number: number;
          state: string;
          state_reason: string | null;
          refs: number;
        } | null;
        active: number;
        waiting: number;
        lead: Array<{ number: number }>;
      };
      session?: { thread?: string };
    }
    const brief = async (projectHint: string): Promise<Pack> => {
      const result = await agent.callTool('build_context', {
        topic: 'nightly jobs',
        briefing: true,
        max_tokens: 1200,
        project_hint: projectHint,
      });
      expect(result.isError ?? false).toBe(false);
      return firstJson<Pack>(result);
    };
    const remember = async (args: Record<string, unknown>) => {
      const stored = await agent.callTool('remember', args);
      expect(stored.isError ?? false).toBe(false);
      return firstJson<{ memory_id: string; scope: string }>(stored);
    };

    try {
      const first = await brief(hint);
      const thread = first.session?.thread;
      expect(thread).toMatch(/^thr_/u);
      // A project with no board work carries no summary.
      expect(first.work).toBeUndefined();

      // Enough knowledge that the ranked leg would fill its six rows.
      const facts = [
        'the nightly export runs after the vacuum, never before it',
        'the report build waits for the backup to finish',
        'the backup window is four in the morning',
        'the vacuum is skipped on the first of the month',
        'the export writes to the cold bucket, never the warm one',
        'the report build retries twice before paging',
        'the cold bucket keeps ninety days of exports',
      ];
      let scope = '';
      for (const fact of facts) {
        scope = (
          await remember({
            content: `e2e brief marker ${stamp}: ${fact}`,
            kind: 'fact',
            project_hint: hint,
          })
        ).scope;
      }
      const loop = await remember({
        content: `e2e brief marker ${stamp}: open loop — confirm the vacuum schedule with ops`,
        kind: 'task',
        project_hint: hint,
      });

      const created = await agent.callTool('card', {
        action: 'create',
        scope,
        title: 'Keep the nightly jobs from colliding',
      });
      expect(created.isError ?? false).toBe(false);
      const card = firstJson<CardResult>(created).card;
      for (const [kind, target] of [
        ['thread', thread],
        ['memory', loop.memory_id],
      ] as const) {
        const attached = await agent.callTool('card_log', {
          action: 'attach',
          card_id: card.id,
          ref_kind: kind,
          ref_target: target,
        });
        expect(attached.isError ?? false).toBe(false);
      }
      const reason = 'the export and the vacuum overlapped twice this week';
      const moved = await agent.callTool('card', {
        action: 'move',
        card_id: card.id,
        to: 'active',
        reason,
      });
      expect(moved.isError ?? false).toBe(false);

      const pack = await brief(hint);
      // THE SUMMARY: this conversation's card, with why it is where it is.
      expect(pack.work?.bound_card?.number).toBe(card.number);
      expect(pack.work?.bound_card?.state).toBe('active');
      expect(pack.work?.bound_card?.state_reason).toBe(reason);
      expect(pack.work?.bound_card?.refs).toBe(2);
      expect(pack.work?.active).toBe(1);
      // The attached loop is reached through its card, not listed again.
      expect(pack.open_loops.map((l) => l.id)).not.toContain(loop.memory_id);
      // DISPLACEMENT: 1200 tokens buy six ranked rows; the summary takes one.
      expect(pack.memories.length).toBeLessThanOrEqual(5);

      // An UNBUDGETED briefing stays exactly as it was: no summary, nothing
      // displaced, and the loop still listed on its own. Only budgeted
      // briefings pay a row for the summary — the displacement was measured
      // harmless at the hooks' size and not at the default.
      const unbudgeted = await agent.callTool('build_context', {
        topic: 'nightly jobs',
        briefing: true,
        project_hint: hint,
      });
      expect(unbudgeted.isError ?? false).toBe(false);
      const plain = firstJson<Pack>(unbudgeted);
      expect(plain.work).toBeUndefined();
      expect(plain.open_loops.map((l) => l.id)).toContain(loop.memory_id);

      // A project with no board work is untouched.
      const bare = await brief(bareHint);
      expect(bare.work).toBeUndefined();
    } finally {
      await agent.close();
    }
  });
});
