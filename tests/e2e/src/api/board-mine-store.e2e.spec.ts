/**
 * The cards a person worked on, as the store lists them: their own work only,
 * newest own work first, with no horizon; and the offer a new session would
 * get, as the dashboard reads it.
 */
import { expect, test } from '@playwright/test';

import {
  admin,
  asOwnerSql,
  asUser,
  makeMember,
  projectScope,
  psql,
  rpc,
  thread,
} from '../helpers/board-store.js';
import { readSeedState } from '../helpers/runtime-state.js';
import { passwordGrantToken } from '../helpers/users.js';

interface CardJson {
  id: string;
  number: number;
  scope: string;
  state: string;
}

interface Step {
  type: string;
  from_state: string | null;
  to_state: string | null;
  text: string | null;
  created_at: string;
}

interface Listed {
  id: string;
  number: number;
  state: string;
  my_last?: Step;
  past_horizon?: boolean;
}

interface Offer {
  horizon_days: number;
  boards: Array<{
    scope: string;
    continuation: {
      card: { number: number } | null;
      last: Step[];
      last_session: { number: number; type: string } | null;
      thread: string | null;
    };
  }>;
}

const markers: string[] = [];

test.afterAll(async () => {
  if (markers.length > 0) {
    await admin().from('memories').delete().in('id', markers);
  }
});

const board = async (tag: string) => {
  const seed = await readSeedState();
  const token = await passwordGrantToken(seed.userA);
  const scope = await projectScope(token, `${tag}-${Date.now()}`, markers);
  const db = asUser(token);
  const create = async (
    title: string,
    state: 'idea' | 'active' | 'waiting'
  ): Promise<CardJson> =>
    (
      await rpc<{ card: CardJson }>(db, 'card_create', {
        p_scope: scope,
        p_title: title,
        p_state: state,
        p_no_links: 'e2e fixture',
        ...(state === 'active' ? { p_no_branch: 'e2e fixture' } : {}),
      })
    ).card;
  const note = (card: CardJson, text: string) =>
    rpc(db, 'card_note', { p_card_id: card.id, p_text: text });
  const mine = async (extra: Record<string, unknown> = {}) =>
    (
      await rpc<{ cards: Listed[] }>(db, 'board_list', {
        p_scope: scope,
        p_worked_by_me: true,
        ...extra,
      })
    ).cards;
  const offer = (p?: string | null) =>
    rpc<Offer>(
      db,
      'board_continuation',
      p === null ? {} : { p_scope: p ?? scope }
    );
  const backdate = (card: CardJson, days: number) =>
    psql(
      `update public.card_events set created_at = now() - interval '${days} days'
        where card_id = '${card.id}'`
    );
  return { seed, token, scope, db, create, note, mine, offer, backdate };
};

test.describe('The cards I worked on', () => {
  test('lists only the cards I worked on, my newest work first', async () => {
    const { create, note, mine } = await board('mine-order');
    const x = await create('Relay keys', 'active');
    const y = await create('Relay rollout', 'idea');
    const z = await create('Relay docs', 'idea');
    await note(y, 'canary first');
    await note(x, `then everywhere ${'x'.repeat(200)}`);

    const cards = await mine();
    expect(cards.map((c) => c.number)).toEqual([x.number, y.number, z.number]);
    expect(cards[0]!.my_last!.type).toBe('noted');
    expect(cards[0]!.my_last!.text!).toHaveLength(120);
    expect(cards[0]!.my_last!.text!.endsWith('…')).toBe(true);
    expect(cards[1]!.my_last!.text).toBe('canary first');
    expect(cards[2]!.my_last).toMatchObject({
      type: 'created',
      to_state: 'idea',
    });
    expect(cards.every((c) => c.past_horizon === false)).toBe(true);
  });

  test("another member's later touch does not lift my card, and their cards are not mine", async () => {
    const { seed, scope, create, note, mine } = await board('mine-others');
    const x = await create('Relay keys', 'active');
    const y = await create('Relay rollout', 'idea');
    await note(y, 'mine, earlier');
    await note(x, 'mine, later');
    await makeMember(scope, seed.userB.id, 'writer');
    const dbB = asUser(await passwordGrantToken(seed.userB));
    await rpc(dbB, 'card_note', { p_card_id: y.id, p_text: 'not yours' });
    const theirs = await rpc<{ card: CardJson }>(dbB, 'card_create', {
      p_scope: scope,
      p_title: 'Their card',
      p_state: 'idea',
      p_no_links: 'e2e fixture',
    });

    const cards = await mine();
    expect(cards.map((c) => c.number)).toEqual([x.number, y.number]);
    expect(cards.some((c) => c.id === theirs.card.id)).toBe(false);
    expect(cards[1]!.my_last!.text).toBe('mine, earlier');
  });

  test('a release and the move it makes are not my work', async () => {
    const { scope, db, create, note, mine } = await board('mine-release');
    const shipped = await create('Relay rollout', 'waiting');
    const x = await create('Relay keys', 'active');
    await note(x, 'keys first');
    await rpc(db, 'release_configure', {
      p_scope: scope,
      p_on_release: 'record_and_move_done',
    });
    const released = await rpc<{ moved: string[] }>(db, 'release_record', {
      p_scope: scope,
      p_version: '9.9.9',
      p_build: null,
      p_release_commit: 'bbbbbbb',
      p_source: 'url',
      p_card_ids: [shipped.id],
    });
    expect(released.moved).toEqual([shipped.id]);

    const cards = await mine();
    expect(cards.map((c) => c.number)).toEqual([x.number, shipped.number]);
    expect(cards[1]!.state).toBe('done');
    expect(cards[1]!.my_last!.type).toBe('created');
  });

  test('work past the horizon stays listed and is marked', async () => {
    const { create, note, mine, backdate } = await board('mine-horizon');
    const recent = await create('Relay keys', 'active');
    const stale = await create('Relay rollout', 'active');
    await note(stale, 'long ago');
    backdate(stale, 31);
    backdate(recent, 29);

    const cards = await mine();
    expect(cards.map((c) => c.number)).toEqual([recent.number, stale.number]);
    expect(cards[0]!.past_horizon).toBe(false);
    expect(cards[1]!.past_horizon).toBe(true);
    expect(cards[1]!.my_last!.text).toBe('long ago');
  });

  test('the horizon mark follows the setting', async () => {
    const { seed, scope, create, backdate } = await board('mine-knob');
    const card = await create('Relay keys', 'active');
    backdate(card, 5);
    const read = (settings: Record<string, string>) =>
      JSON.parse(
        asOwnerSql(
          seed.userA.id,
          `select public.board_list(p_scope => '${scope}', p_worked_by_me => true)::text`,
          settings
        )
      ) as { cards: Listed[] };

    expect(read({}).cards[0]!.past_horizon).toBe(false);
    expect(
      read({ 'zm.continuation_horizon_days': '3' }).cards[0]!.past_horizon
    ).toBe(true);
  });

  test("without the flag no step of mine rides along, and age is the card's own", async () => {
    const { db, scope, create, note, backdate } = await board('mine-off');
    const fresh = await create('Relay keys', 'active');
    await note(fresh, 'keys first');
    const stale = await create('Relay rollout', 'idea');
    backdate(stale, 31);
    const listed = await rpc<{
      cards: Array<Record<string, unknown> & { id: string }>;
      horizon_days: number;
    }>(db, 'board_list', { p_scope: scope });
    expect(listed.horizon_days).toBe(30);
    expect(listed.cards).toHaveLength(2);
    for (const card of listed.cards) {
      expect(card).not.toHaveProperty('my_last');
    }
    const byId = new Map(listed.cards.map((c) => [c.id, c]));
    expect(byId.get(fresh.id)!.past_horizon).toBe(false);
    expect(byId.get(stale.id)!.past_horizon).toBe(true);
  });

  test('on the regular board a card is as old as its last event, whoever wrote it', async () => {
    const { seed, scope, create, backdate } = await board('board-age');
    const card = await create('Relay keys', 'idea');
    backdate(card, 31);
    await makeMember(scope, seed.userB.id, 'writer');
    const dbB = asUser(await passwordGrantToken(seed.userB));
    const read = async () =>
      (
        await rpc<{ cards: Array<{ id: string; past_horizon?: boolean }> }>(
          dbB,
          'board_list',
          { p_scope: scope }
        )
      ).cards.find((c) => c.id === card.id)!.past_horizon;
    expect(await read()).toBe(true);
    await rpc(dbB, 'card_note', { p_card_id: card.id, p_text: 'still here' });
    expect(await read()).toBe(false);
  });

  test('narrows together with a title, a column and a relation', async () => {
    const { db, create, mine } = await board('mine-and');
    const x = await create('Relay keys', 'active');
    const y = await create('Relay rollout', 'idea');
    await rpc(db, 'card_link', {
      p_card_id: y.id,
      p_to: x.id,
      p_relation: 'depends_on',
      p_reason: 'e2e fixture',
    });

    expect((await mine({ p_query: 'rollout' })).map((c) => c.number)).toEqual([
      y.number,
    ]);
    expect((await mine({ p_state: 'active' })).map((c) => c.number)).toEqual([
      x.number,
    ]);
    expect((await mine({ p_related_to: y.id })).map((c) => c.number)).toEqual([
      x.number,
    ]);
  });
});

test.describe('What a new session would be offered', () => {
  test('is the briefing offer, with no conversation of its own', async () => {
    const { db, scope, create, note, offer } = await board('offer-one');
    const x = await create('Relay keys', 'active');
    await note(x, 'keys first');

    const result = await offer();
    expect(result.horizon_days).toBe(30);
    expect(result.boards).toHaveLength(1);
    expect(result.boards[0]!.scope).toBe(scope);
    const briefed = await rpc<{
      continuation: { card: { number: number } | null; last: Step[] };
    }>(db, 'briefing_work', { p_scope: scope, p_thread: thread('b') });
    expect(result.boards[0]!.continuation.card?.number).toBe(
      briefed.continuation.card?.number
    );
    expect(result.boards[0]!.continuation.last).toEqual(
      briefed.continuation.last
    );
    expect(result.boards[0]!.continuation.thread).toBeNull();
  });

  test('across boards: one entry per board that has something to say', async () => {
    const one = await board('offer-all-a');
    const two = await board('offer-all-b');
    const x = await one.create('Relay keys', 'active');
    await one.note(x, 'keys first');
    const old = await two.create('Relay rollout', 'active');
    two.backdate(old, 31);

    const result = await one.offer(null);
    const scopes = result.boards.map((b) => b.scope);
    expect(scopes).toContain(one.scope);
    expect(scopes).not.toContain(two.scope);
    expect(
      result.boards.find((b) => b.scope === one.scope)!.continuation.card
        ?.number
    ).toBe(x.number);
  });

  test('with no active card, a board still names the last step', async () => {
    const { db, create, offer } = await board('offer-none');
    const x = await create('Relay keys', 'active');
    await rpc(db, 'card_move', {
      p_card_id: x.id,
      p_to_state: 'done',
      p_reason: 'shipped',
    });

    const entry = (await offer()).boards[0]!.continuation;
    expect(entry.card).toBeNull();
    expect(entry.last_session).toMatchObject({
      number: x.number,
      type: 'moved',
    });
  });

  test('a board I cannot see offers nothing', async () => {
    const seed = await readSeedState();
    const tokenB = await passwordGrantToken(seed.userB);
    const hidden = await projectScope(
      tokenB,
      `offer-hidden-${Date.now()}`,
      markers
    );
    const dbB = asUser(tokenB);
    const card = await rpc<{ card: CardJson }>(dbB, 'card_create', {
      p_scope: hidden,
      p_title: 'Theirs',
      p_state: 'active',
      p_no_links: 'e2e fixture',
      p_no_branch: 'e2e fixture',
    });
    expect(card.card.number).toBeGreaterThan(0);

    const dbA = asUser(await passwordGrantToken(seed.userA));
    const result = await rpc<Offer>(dbA, 'board_continuation', {
      p_scope: hidden,
    });
    expect(result.boards).toEqual([]);
  });
});
