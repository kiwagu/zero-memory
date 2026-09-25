/**
 * The card a new session is offered to continue, as the store picks it: the
 * caller's own latest work, never the calling conversation's, still active,
 * within the horizon — and the caller's last step when it was on another card.
 */
import { spawnSync } from 'node:child_process';

import { expect, test } from '@playwright/test';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import { e2eEnv } from '../helpers/env.js';
import { firstJson, McpTestClient } from '../helpers/mcp.js';
import { readSeedState } from '../helpers/runtime-state.js';
import { passwordGrantToken } from '../helpers/users.js';

interface CardJson {
  id: string;
  number: number;
  scope: string;
  state: string;
}

interface Continuation {
  card: {
    id: string;
    number: number;
    title: string;
    state: string;
    state_reason: string | null;
  } | null;
  last: Array<{
    type: string;
    from_state: string | null;
    to_state: string | null;
    text: string | null;
    created_at: string;
  }>;
  last_session: {
    number: number;
    title: string;
    type: string;
    to_state: string | null;
  } | null;
  thread: string | null;
}

interface Work {
  bound_card: { number: number } | null;
  continuation?: Continuation | null;
}

const asUser = (token: string): SupabaseClient =>
  createClient(e2eEnv.supabaseUrl, e2eEnv.supabaseAnonKey, {
    auth: { persistSession: false },
    global: { headers: { Authorization: `Bearer ${token}` } },
  });

const admin = (): SupabaseClient =>
  createClient(e2eEnv.supabaseUrl, e2eEnv.supabaseServiceRoleKey, {
    auth: { persistSession: false },
  });

/**
 * The memories this file writes only to make a project scope, deleted when
 * the file is done so they do not crowd later specs.
 */
const markers: string[] = [];

test.afterAll(async () => {
  if (markers.length > 0) {
    await admin().from('memories').delete().in('id', markers);
  }
});

/** A project scope the caller may write, made the way an agent makes one. */
const projectScope = async (token: string, tag: string): Promise<string> => {
  const agent = await McpTestClient.connect(token);
  try {
    const made = await agent.callTool('remember', {
      content: `e2e continuation marker ${tag}: the relay drops frames under load`,
      kind: 'fact',
      project_hint: `/tmp/zm-e2e-${tag}`,
    });
    expect(made.isError ?? false).toBe(false);
    const { scope, memory_id } = firstJson<{
      scope: string;
      memory_id: string;
    }>(made);
    markers.push(memory_id);
    return scope;
  } finally {
    await agent.close();
  }
};

const rpc = async <T>(
  client: SupabaseClient,
  fn: string,
  args: Record<string, unknown>
): Promise<T> => {
  const { data, error } = await client.rpc(fn, args);
  if (error) {
    throw new Error(`${fn}: ${error.message}`);
  }
  return data as T;
};

/** SQL as the database owner, for fixtures no role may write through the API. */
const psql = (query: string): string => {
  const result = spawnSync(
    'docker',
    [
      'run',
      '--rm',
      '--network',
      'host',
      '-i',
      'supabase/postgres:17.6.1.136',
      'psql',
      'postgresql://postgres:postgres@127.0.0.1:55332/postgres',
      '-v',
      'ON_ERROR_STOP=1',
      '-Atc',
      query,
    ],
    { encoding: 'utf8' }
  );
  if (result.status !== 0) {
    throw new Error(`psql: ${result.stderr}`);
  }
  return result.stdout.trim();
};

/** Adds a user to a board with a role, and answers their profile id. */
async function makeMember(
  scope: string,
  authUserId: string,
  role: 'reader' | 'writer'
): Promise<string> {
  const { data: profile } = await admin()
    .from('profiles')
    .select('id')
    .eq('user_id', authUserId)
    .single();
  const joined = await admin()
    .from('scope_members')
    .upsert(
      {
        scope,
        user_id: (profile as { id: string }).id,
        role,
        accepted_at: new Date().toISOString(),
      },
      { onConflict: 'scope,user_id' }
    );
  expect(joined.error).toBeNull();
  return (profile as { id: string }).id;
}

/**
 * A conversation of its own; `tag` is one letter of the id alphabet
 * (Crockford base32 has no i, l, o or u).
 */
const thread = (tag: string): string =>
  `thr_e2ecnt${tag}${String(Date.now()).slice(-9)}.0000000000`;

const board = async (tag: string) => {
  const seed = await readSeedState();
  const token = await passwordGrantToken(seed.userA);
  const scope = await projectScope(token, `${tag}-${Date.now()}`);
  const db = asUser(token);
  const create = async (
    title: string,
    state: 'active' | 'waiting',
    t: string | null
  ): Promise<CardJson> =>
    (
      await rpc<{ card: CardJson }>(db, 'card_create', {
        p_scope: scope,
        p_title: title,
        p_state: state,
        p_no_links: 'e2e fixture',
        ...(state === 'active' ? { p_no_branch: 'e2e fixture' } : {}),
        ...(t ? { p_thread: t } : {}),
      })
    ).card;
  const note = (card: CardJson, text: string, t: string | null) =>
    rpc(db, 'card_note', {
      p_card_id: card.id,
      p_text: text,
      ...(t ? { p_thread: t } : {}),
    });
  const move = (card: CardJson, to: string, reason: string, t: string | null) =>
    rpc(db, 'card_move', {
      p_card_id: card.id,
      p_to_state: to,
      p_reason: reason,
      ...(t ? { p_thread: t } : {}),
    });
  const work = (t: string | null) =>
    rpc<Work>(db, 'briefing_work', {
      p_scope: scope,
      ...(t ? { p_thread: t } : {}),
    });
  return { seed, scope, db, create, note, move, work };
};

test.describe('A new session is offered where it left off', () => {
  test('offers the active card the caller worked on last, with its two newest entries', async () => {
    const { create, note, work } = await board('cont-offer');
    const earlier = thread('a');
    const older = await create('Relay keys', 'active', earlier);
    const card = await create('Relay rollout', 'active', earlier);
    await note(older, 'keys rotate weekly', earlier);
    await note(card, 'first a canary on one region', earlier);
    await note(card, `then everywhere ${'x'.repeat(200)}`, earlier);

    const now = thread('b');
    const result = await work(now);
    expect(result.bound_card).toBeNull();
    const cont = result.continuation!;
    expect(cont.card?.number).toBe(card.number);
    expect(cont.last).toHaveLength(2);
    expect(cont.last[0]!.type).toBe('noted');
    expect(cont.last[0]!.text!).toHaveLength(120);
    expect(cont.last[0]!.text!.endsWith('…')).toBe(true);
    expect(cont.last[1]!.text).toBe('first a canary on one region');
    expect(cont.last_session).toBeNull();
    expect(cont.thread).toBe(now);
  });

  test("an entry's text reaches the briefing as one line, whitespace and all", async () => {
    const { create, note, work } = await board('cont-oneline');
    const t = thread('a');
    const card = await create('Relay keys', 'active', t);
    await note(
      card,
      `Plan:\n${' '.repeat(120)}rotate the keys first\n\n- then ship`,
      t
    );

    const cont = (await work(thread('b'))).continuation!;
    expect(cont.last[0]!.text).toBe('Plan: rotate the keys first - then ship');
  });

  test('names the last step when it finished another card, and offers the active one before it', async () => {
    const { create, note, move, work } = await board('cont-last');
    const t = thread('a');
    const still = await create('Relay keys', 'active', t);
    const finished = await create('Relay rollout', 'active', t);
    await note(still, 'keys first', t);
    await move(finished, 'waiting', 'shipped behind a flag', t);

    const cont = (await work(thread('b'))).continuation!;
    expect(cont.card?.number).toBe(still.number);
    expect(cont.last[0]!.text).toBe('keys first');
    expect(cont.last_session).toEqual({
      number: finished.number,
      title: 'Relay rollout',
      type: 'moved',
      to_state: 'waiting',
    });
  });

  test('with no active card of the caller, only the last step is named', async () => {
    const { create, move, work } = await board('cont-none');
    const t = thread('a');
    const card = await create('Relay rollout', 'active', t);
    await move(card, 'done', 'shipped', t);

    const result = await work(thread('b'));
    expect(result.continuation!.card).toBeNull();
    expect(result.continuation!.last).toEqual([]);
    expect(result.continuation!.last_session).toMatchObject({
      number: card.number,
      type: 'moved',
      to_state: 'done',
    });
  });

  test("a conversation's own entries never make its offer", async () => {
    const { create, note, work } = await board('cont-own');
    const earlier = thread('a');
    const mine = thread('b');
    const before = await create('Relay keys', 'active', earlier);
    const now = await create('Relay rollout', 'active', mine);
    await note(now, 'working on it right now', mine);

    const cont = (await work(mine)).continuation!;
    expect(cont.card?.number).toBe(before.number);
    expect(cont.last_session).toBeNull();
  });

  test('entries with no thread count as earlier work', async () => {
    const { create, note, work } = await board('cont-nothread');
    const card = await create('Relay keys', 'active', null);
    await note(card, 'noted from a client without a thread', null);

    const cont = (await work(thread('b'))).continuation!;
    expect(cont.card?.number).toBe(card.number);
    expect(cont.last[0]!.text).toBe('noted from a client without a thread');
  });

  test('released entries and another member are not your work', async () => {
    const { seed, scope, db, create, note, work } = await board('cont-others');
    const t = thread('a');
    const other = await create('Relay rollout', 'active', t);
    const mine = await create('Relay keys', 'active', t);
    await note(mine, 'mine', t);
    // After my note: a release recorded as me on the other card, and another
    // member's note on it.
    const released = await rpc<{ recorded: string[] }>(db, 'release_record', {
      p_scope: scope,
      p_version: '9.9.9',
      p_build: null,
      p_release_commit: 'bbbbbbb',
      p_source: 'url',
      p_card_ids: [other.id],
    });
    expect(released.recorded).toEqual([other.id]);
    await makeMember(scope, seed.userB.id, 'writer');
    const dbB = asUser(await passwordGrantToken(seed.userB));
    await rpc(dbB, 'card_note', { p_card_id: other.id, p_text: 'not yours' });

    const cont = (await work(thread('b'))).continuation!;
    expect(cont.card?.number).toBe(mine.number);
    expect(cont.last_session).toBeNull();
  });

  test('a release that closes a card is not your last step', async () => {
    const { scope, db, create, note, work } = await board('cont-release');
    const t = thread('a');
    const shipped = await create('Relay rollout', 'waiting', t);
    const mine = await create('Relay keys', 'active', t);
    await note(mine, 'mine', t);
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

    const cont = (await work(thread('b'))).continuation!;
    expect(cont.card?.number).toBe(mine.number);
    expect(cont.last_session).toBeNull();
  });

  test('an archived card is never offered', async () => {
    const { db, create, note, work } = await board('cont-archived');
    const t = thread('a');
    const keep = await create('Relay keys', 'active', t);
    await note(keep, 'keys first', t);
    const gone = await create('Relay rollout', 'active', t);
    await note(gone, 'then the rollout', t);
    await rpc(db, 'card_archive', { p_card_id: gone.id, p_reason: 'split up' });

    const cont = (await work(thread('b'))).continuation!;
    expect(cont.card?.number).toBe(keep.number);
  });

  test('work past the horizon is neither offered nor named', async () => {
    const { create, note, work } = await board('cont-horizon');
    const t = thread('a');
    const recent = await create('Relay keys', 'active', t);
    const stale = await create('Relay rollout', 'active', t);
    await note(stale, 'long ago', t);
    psql(
      `update public.card_events set created_at = now() - interval '31 days'
        where card_id = '${stale.id}'`
    );
    psql(
      `update public.card_events set created_at = now() - interval '29 days'
        where card_id = '${recent.id}'`
    );

    const cont = (await work(thread('b'))).continuation!;
    expect(cont.card?.number).toBe(recent.number);
    expect(cont.last_session).toBeNull();

    psql(
      `update public.card_events set created_at = now() - interval '31 days'
        where card_id = '${recent.id}'`
    );
    expect((await work(thread('c'))).continuation).toBeNull();
  });

  test('a bound conversation gets its bound card, not an offer', async () => {
    const { db, create, work } = await board('cont-bound');
    const card = await create('Relay keys', 'active', thread('a'));
    const bound = thread('b');
    await rpc(db, 'card_attach', {
      p_card_id: card.id,
      p_kind: 'thread',
      p_target: bound,
    });

    const result = await work(bound);
    expect(result.bound_card?.number).toBe(card.number);
    expect(result.continuation).toBeNull();
  });
});
