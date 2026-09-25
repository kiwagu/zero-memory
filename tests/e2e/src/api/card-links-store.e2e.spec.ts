/**
 * Card-to-card relations at the level a direct PostgREST call meets them. A
 * relation has a type, a reason and two sides: it is stored once and read
 * from either card, it is visible only where both cards are, and a relation
 * that would put a card above itself — through parents, blockers or
 * dependencies — is refused.
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

interface LinkResult {
  error?: string;
  message?: string;
  changed?: boolean;
  card?: CardJson;
}

interface LinkRow {
  src_card_id: string;
  dst_card_id: string;
  type: string;
  reason: string;
  declared: boolean;
  invalidated_at: string | null;
}

interface EventRow {
  type: string;
  ref_kind: string | null;
  ref_target: string | null;
  link_type: string | null;
  link_direction: string | null;
  reason: string | null;
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

/** A project scope the caller may write, made the way an agent makes one. */
const projectScope = async (token: string, tag: string): Promise<string> => {
  const agent = await McpTestClient.connect(token);
  try {
    const made = await agent.callTool('remember', {
      content: `e2e card links marker ${tag}: the relay drops frames under load`,
      kind: 'fact',
      project_hint: `/tmp/zm-e2e-${tag}`,
    });
    expect(made.isError ?? false).toBe(false);
    return firstJson<{ scope: string }>(made).scope;
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

const newCard = async (
  db: SupabaseClient,
  scope: string,
  title: string
): Promise<CardJson> =>
  (
    await rpc<{ card: CardJson }>(db, 'card_create', {
      p_scope: scope,
      p_title: title,
      p_no_links: 'e2e fixture',
    })
  ).card;

const link = (
  db: SupabaseClient,
  card: string,
  to: string,
  relation: string,
  reason = 'e2e relation'
): Promise<LinkResult> =>
  rpc<LinkResult>(db, 'card_link', {
    p_card_id: card,
    p_to: to,
    p_relation: relation,
    p_reason: reason,
  });

const unlink = (
  db: SupabaseClient,
  card: string,
  to: string,
  relation: string,
  reason = 'e2e unlink'
): Promise<LinkResult> =>
  rpc<LinkResult>(db, 'card_unlink', {
    p_card_id: card,
    p_to: to,
    p_relation: relation,
    p_reason: reason,
  });

const rowsBetween = async (
  db: SupabaseClient,
  a: string,
  b: string
): Promise<LinkRow[]> => {
  const { data, error } = await db
    .from('card_links')
    .select('src_card_id, dst_card_id, type, reason, declared, invalidated_at')
    .or(
      `and(src_card_id.eq.${a},dst_card_id.eq.${b}),and(src_card_id.eq.${b},dst_card_id.eq.${a})`
    );
  expect(error).toBeNull();
  return (data ?? []) as LinkRow[];
};

const lastEvent = async (
  db: SupabaseClient,
  card: string
): Promise<EventRow> => {
  const { data, error } = await db
    .from('card_events')
    .select('type, ref_kind, ref_target, link_type, link_direction, reason')
    .eq('card_id', card)
    .order('seq', { ascending: false })
    .limit(1)
    .single();
  expect(error).toBeNull();
  return data as EventRow;
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

interface Candidate {
  id: string;
  number: number;
  title: string;
  state: string;
  why: 'mentioned' | 'similar';
}

interface CreateResult {
  error?: string;
  message?: string;
  card?: CardJson;
  candidates?: Candidate[];
}

const board = async (tag: string) => {
  const seed = await readSeedState();
  const token = await passwordGrantToken(seed.userA);
  const scope = await projectScope(token, `${tag}-${Date.now()}`);
  return { seed, token, scope, db: asUser(token) };
};

test.describe('Card links in the store', () => {
  test('links two cards with a type and records it on both sides', async () => {
    const { scope, db } = await board('links-both');
    const a = await newCard(db, scope, 'Rotate the relay keys');
    const b = await newCard(db, scope, 'Ship the relay');

    const made = await link(
      db,
      a.id,
      b.id,
      'blocks',
      'b cannot ship on old keys'
    );
    expect(made.error).toBeUndefined();
    expect(made.changed).toBe(true);

    expect(await rowsBetween(db, a.id, b.id)).toEqual([
      {
        src_card_id: a.id,
        dst_card_id: b.id,
        type: 'blocks',
        reason: 'b cannot ship on old keys',
        declared: true,
        invalidated_at: null,
      },
    ]);
    expect(await lastEvent(db, a.id)).toEqual({
      type: 'linked',
      ref_kind: 'card',
      ref_target: b.id,
      link_type: 'blocks',
      link_direction: 'out',
      reason: 'b cannot ship on old keys',
    });
    expect(await lastEvent(db, b.id)).toMatchObject({
      type: 'linked',
      ref_target: a.id,
      link_type: 'blocks',
      link_direction: 'in',
    });
  });

  test('an inverse relation name states the same link', async () => {
    const { scope, db } = await board('links-inverse');
    const a = await newCard(db, scope, 'Rotate the relay keys');
    const b = await newCard(db, scope, 'Ship the relay');
    expect((await link(db, a.id, b.id, 'blocks')).changed).toBe(true);
    expect((await link(db, b.id, a.id, 'blocked_by')).changed).toBe(false);
    expect(await rowsBetween(db, a.id, b.id)).toHaveLength(1);
  });

  test('relates_to is one row whichever side states it', async () => {
    const { scope, db } = await board('links-relates');
    const a = await newCard(db, scope, 'Relay metrics');
    const b = await newCard(db, scope, 'Relay dashboards');
    expect((await link(db, a.id, b.id, 'relates_to')).changed).toBe(true);
    expect((await link(db, b.id, a.id, 'relates_to')).changed).toBe(false);
    expect(await rowsBetween(db, a.id, b.id)).toHaveLength(1);
  });

  test('refuses a link to itself, an unknown relation and a blank reason', async () => {
    const { scope, db } = await board('links-refused');
    const a = await newCard(db, scope, 'Relay metrics');
    const b = await newCard(db, scope, 'Relay dashboards');
    expect((await link(db, a.id, a.id, 'relates_to')).error).toBe('invalid');
    expect((await link(db, a.id, b.id, 'causes')).error).toBe('invalid');
    expect((await link(db, a.id, b.id, 'blocks', '   ')).error).toBe('invalid');
    expect(await rowsBetween(db, a.id, b.id)).toEqual([]);
  });

  test("resolves a label only on the card's own board", async () => {
    const { token, scope, db } = await board('links-label');
    const other = await projectScope(token, `links-label-other-${Date.now()}`);
    const a = await newCard(db, scope, 'Relay metrics');
    const b = await newCard(db, scope, 'Relay dashboards');
    // A card numbered higher than anything on the first board, on the second.
    for (const title of ['one', 'two', 'three', 'four']) {
      await newCard(db, other, `other board ${title}`);
    }

    const byLabel = await link(db, a.id, `ZM-${b.number}`, 'depends_on');
    expect(byLabel.error).toBeUndefined();
    expect(await rowsBetween(db, a.id, b.id)).toHaveLength(1);

    // ZM-4 exists only on the other board: it is not this board's card.
    const elsewhere = await link(db, a.id, 'ZM-4', 'depends_on');
    expect(elsewhere.error).toBe('not_found');
  });

  test('a second parent is refused with the parent it already has', async () => {
    const { scope, db } = await board('links-parent');
    const p1 = await newCard(db, scope, 'Relay epic');
    const p2 = await newCard(db, scope, 'Transport epic');
    const c = await newCard(db, scope, 'Relay keys');
    expect((await link(db, p1.id, c.id, 'parent_of')).changed).toBe(true);
    const second = await link(db, c.id, p2.id, 'child_of');
    expect(second.error).toBe('invalid');
    expect(second.message).toContain(`ZM-${p1.number}`);
  });

  test('a link that would put a card above itself is refused', async () => {
    const { scope, db } = await board('links-cycle');
    const a = await newCard(db, scope, 'Relay epic');
    const b = await newCard(db, scope, 'Relay keys');
    const c = await newCard(db, scope, 'Relay ship');
    expect((await link(db, a.id, b.id, 'parent_of')).changed).toBe(true);
    expect((await link(db, b.id, c.id, 'blocks')).changed).toBe(true);
    // A depending on C would put C above A, and A is already above C.
    const dependency = await link(db, a.id, c.id, 'depends_on');
    expect(dependency.error).toBe('invalid');
    expect(dependency.message).toContain('above itself');
    // C blocking A closes the same loop through a blocker.
    expect((await link(db, c.id, a.id, 'blocks')).error).toBe('invalid');
    // Relations that do not rank cards never form a cycle.
    expect((await link(db, c.id, a.id, 'relates_to')).changed).toBe(true);
  });

  test('two links that close a cycle together cannot both land', async () => {
    const { scope, db } = await board('links-race');
    const a = await newCard(db, scope, 'Relay epic');
    const b = await newCard(db, scope, 'Relay keys');
    const c = await newCard(db, scope, 'Relay ship');
    expect((await link(db, a.id, b.id, 'blocks')).changed).toBe(true);
    const results = await Promise.all([
      link(db, b.id, c.id, 'blocks'),
      link(db, c.id, a.id, 'blocks'),
    ]);
    const refused = results.filter((result) => result.error === 'invalid');
    expect(refused).toHaveLength(1);
    expect(results.filter((result) => result.changed === true)).toHaveLength(1);
  });

  test('unlinking invalidates, relinking revives, and both sides record it', async () => {
    const { scope, db } = await board('links-unlink');
    const a = await newCard(db, scope, 'Rotate the relay keys');
    const b = await newCard(db, scope, 'Ship the relay');
    await link(db, a.id, b.id, 'blocks', 'first reason');

    const gone = await unlink(db, b.id, a.id, 'blocked_by', 'keys rotated');
    expect(gone.error).toBeUndefined();
    const [row] = await rowsBetween(db, a.id, b.id);
    expect(row?.invalidated_at).not.toBeNull();
    expect(await lastEvent(db, a.id)).toMatchObject({
      type: 'unlinked',
      ref_target: b.id,
      link_type: 'blocks',
      reason: 'keys rotated',
    });
    expect(await lastEvent(db, b.id)).toMatchObject({ type: 'unlinked' });
    expect((await unlink(db, a.id, b.id, 'blocks')).error).toBe('not_linked');

    expect(
      (await link(db, a.id, b.id, 'blocks', 'blocked again')).changed
    ).toBe(true);
    expect(await rowsBetween(db, a.id, b.id)).toEqual([
      expect.objectContaining({
        invalidated_at: null,
        reason: 'blocked again',
      }),
    ]);
  });

  test('a stranger cannot link to a card they cannot see, or write a link directly', async () => {
    const { seed, scope, db } = await board('links-stranger');
    const a = await newCard(db, scope, 'Rotate the relay keys');
    const tokenB = await passwordGrantToken(seed.userB);
    const dbB = asUser(tokenB);
    const own = await projectScope(tokenB, `links-stranger-b-${Date.now()}`);
    const mine = await newCard(dbB, own, 'Stranger card');

    expect((await link(dbB, mine.id, a.id, 'relates_to')).error).toBe(
      'not_found'
    );
    const forged = await dbB.from('card_links').insert({
      src_card_id: mine.id,
      dst_card_id: a.id,
      type: 'blocks',
      src_scope: own,
      dst_scope: scope,
      reason: 'forged',
    });
    expect(forged.error).not.toBeNull();
  });

  test('links across boards need write rights on both', async () => {
    const { seed, token, scope, db } = await board('links-cross');
    const other = await projectScope(token, `links-cross-other-${Date.now()}`);
    const a = await newCard(db, scope, 'Relay keys');
    const b = await newCard(db, other, 'Transport keys');
    expect((await link(db, a.id, b.id, 'depends_on')).changed).toBe(true);

    // User B may READ the first board but writes only their own.
    const tokenB = await passwordGrantToken(seed.userB);
    const dbB = asUser(tokenB);
    const { data: profile } = await admin()
      .from('profiles')
      .select('id')
      .eq('user_id', seed.userB.id)
      .single();
    const joined = await admin()
      .from('scope_members')
      .upsert(
        {
          scope,
          user_id: (profile as { id: string }).id,
          role: 'reader',
          accepted_at: new Date().toISOString(),
        },
        { onConflict: 'scope,user_id' }
      );
    expect(joined.error).toBeNull();
    const own = await projectScope(tokenB, `links-cross-b-${Date.now()}`);
    const mine = await newCard(dbB, own, 'Reader card');
    expect((await link(dbB, mine.id, a.id, 'relates_to')).error).toBe(
      'forbidden'
    );
  });
});

test.describe('Relations are assessed', () => {
  test('a card is created with its relations, or with a stated reason for none', async () => {
    const { scope, db } = await board('assess-create');
    const base = await newCard(db, scope, 'Relay keys');

    const bare = await rpc<CreateResult>(db, 'card_create', {
      p_scope: scope,
      p_title: 'Relay rollout',
    });
    expect(bare.error).toBe('links_required');
    expect(Array.isArray(bare.candidates)).toBe(true);

    const none = await rpc<CreateResult>(db, 'card_create', {
      p_scope: scope,
      p_title: 'Relay rollout',
      p_no_links: 'a standalone rollout',
    });
    expect(none.error).toBeUndefined();
    const { data: created } = await db
      .from('card_events')
      .select('type, links_note')
      .eq('card_id', none.card!.id)
      .eq('type', 'created')
      .single();
    expect(created).toEqual({
      type: 'created',
      links_note: 'a standalone rollout',
    });

    const linked = await rpc<CreateResult>(db, 'card_create', {
      p_scope: scope,
      p_title: 'Relay second rollout',
      p_links: [
        {
          card: `ZM-${base.number}`,
          relation: 'depends_on',
          reason: 'needs keys',
        },
      ],
    });
    expect(linked.error).toBeUndefined();
    expect(await rowsBetween(db, linked.card!.id, base.id)).toEqual([
      expect.objectContaining({
        src_card_id: linked.card!.id,
        dst_card_id: base.id,
        type: 'depends_on',
        declared: true,
      }),
    ]);
    expect(await lastEvent(db, base.id)).toMatchObject({
      type: 'linked',
      link_direction: 'in',
    });

    const both = await rpc<CreateResult>(db, 'card_create', {
      p_scope: scope,
      p_title: 'Relay third rollout',
      p_links: [
        { card: base.id, relation: 'relates_to', reason: 'same relay' },
      ],
      p_no_links: 'none',
    });
    expect(both.error).toBe('invalid');
    const blank = await rpc<CreateResult>(db, 'card_create', {
      p_scope: scope,
      p_title: 'Relay third rollout',
      p_no_links: '   ',
    });
    expect(blank.error).toBe('invalid');
    const unknown = await rpc<CreateResult>(db, 'card_create', {
      p_scope: scope,
      p_title: 'Relay third rollout',
      p_links: [{ card: 'ZM-9999', relation: 'relates_to', reason: 'why' }],
    });
    expect(unknown.error).toBe('not_found');
    const { count } = await db
      .from('cards')
      .select('id', { count: 'exact', head: true })
      .eq('scope', scope)
      .eq('title', 'Relay third rollout');
    expect(count).toBe(0);
  });

  test('a card whose relations close a loop is not created at all', async () => {
    const { scope, db } = await board('assess-atomic');
    const a = await newCard(db, scope, 'Relay keys');
    const refused = await rpc<CreateResult>(db, 'card_create', {
      p_scope: scope,
      p_title: 'Relay loop',
      p_links: [
        { card: a.id, relation: 'blocks', reason: 'first' },
        { card: a.id, relation: 'depends_on', reason: 'second' },
      ],
    });
    expect(refused.error).toBe('invalid');
    const { count } = await db
      .from('cards')
      .select('id', { count: 'exact', head: true })
      .eq('scope', scope)
      .eq('title', 'Relay loop');
    expect(count).toBe(0);
  });

  test('candidates name the cards a text mentions and the ones it resembles', async () => {
    const { scope, db } = await board('assess-candidates');
    const certs = await newCard(db, scope, 'Rotate the edge certificates');
    const index = await newCard(db, scope, 'Search index rebuild');
    const archived = await newCard(db, scope, 'Certificates archive sweep');
    await rpc(db, 'card_archive', {
      p_card_id: archived.id,
      p_reason: 'dropped',
    });

    const refused = await rpc<CreateResult>(db, 'card_create', {
      p_scope: scope,
      p_title: 'Certificates expire early',
      p_body: `Found while doing ZM-${index.number}: the edge certificates expire.`,
    });
    expect(refused.error).toBe('links_required');
    const candidates = refused.candidates ?? [];
    expect(candidates.length).toBeLessThanOrEqual(5);
    expect(candidates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: index.id, why: 'mentioned' }),
        expect.objectContaining({ id: certs.id, why: 'similar' }),
      ])
    );
    expect(candidates.map((candidate) => candidate.id)).not.toContain(
      archived.id
    );
  });

  test('an unassessed card entering active must assess its relations once', async () => {
    const { scope, db } = await board('assess-move');
    // A card from before the rule: created with no statement about relations.
    const { data: profile } = await admin()
      .from('profiles')
      .select('id')
      .eq('user_id', (await readSeedState()).userA.id)
      .single();
    const { data: old } = await admin()
      .from('cards')
      .insert({
        scope,
        number: 90,
        title: 'Card from before the rule',
        state: 'idea',
        created_by: (profile as { id: string }).id,
      })
      .select('id')
      .single();
    const oldId = (old as { id: string }).id;

    const enter = (extra: Record<string, unknown>) =>
      rpc<CreateResult>(db, 'card_move', {
        p_card_id: oldId,
        p_to_state: 'active',
        p_reason: 'picked up',
        p_no_branch: 'e2e fixture',
        ...extra,
      });
    const refused = await enter({});
    expect(refused.error).toBe('links_required');
    expect(Array.isArray(refused.candidates)).toBe(true);
    expect((await enter({ p_no_links: 'nothing on this board' })).error).toBe(
      undefined
    );
    await rpc(db, 'card_move', {
      p_card_id: oldId,
      p_to_state: 'waiting',
      p_reason: 'paused',
    });
    // Assessed once, it enters active again without a new statement.
    expect((await enter({})).error).toBeUndefined();
  });

  test('promoting a loop takes the same statement', async () => {
    const { token, scope, db } = await board('assess-promote');
    const agent = await McpTestClient.connect(token);
    let loopId: string;
    try {
      const loop = await agent.callTool('remember', {
        content: `assess-promote loop ${Date.now()}: migrate the relay queue`,
        kind: 'task',
        scope,
      });
      expect(loop.isError ?? false).toBe(false);
      loopId = firstJson<{ memory_id: string }>(loop).memory_id;
    } finally {
      await agent.close();
    }
    const promote = (extra: Record<string, unknown>) =>
      rpc<CreateResult>(db, 'card_promote_loop', {
        p_loop_id: loopId,
        p_title: 'Migrate the relay queue',
        p_no_branch: 'e2e fixture',
        ...extra,
      });
    expect((await promote({})).error).toBe('links_required');
    expect(
      (await promote({ p_no_links: 'first card of its kind' })).error
    ).toBe(undefined);
  });

  test('attaching a card states an untyped relation, which a typed one replaces', async () => {
    const { scope, db } = await board('assess-attach');
    const a = await newCard(db, scope, 'Relay keys');
    const b = await newCard(db, scope, 'Relay rollout');
    const attach = () =>
      rpc<{ changed: boolean }>(db, 'card_attach', {
        p_card_id: a.id,
        p_kind: 'card',
        p_target: b.id,
      });

    expect((await attach()).changed).toBe(true);
    expect(await rowsBetween(db, a.id, b.id)).toEqual([
      expect.objectContaining({ type: 'relates_to', declared: false }),
    ]);
    expect(await lastEvent(db, a.id)).toMatchObject({ type: 'linked' });
    expect((await attach()).changed).toBe(false);

    // A typed relation of the pair retires the untyped one…
    await link(db, a.id, b.id, 'blocks', 'keys first');
    const rows = await rowsBetween(db, a.id, b.id);
    expect(
      rows.find((row) => row.type === 'relates_to')?.invalidated_at
    ).not.toBeNull();
    // …and attaching again never stands an untyped relation over it.
    expect((await attach()).changed).toBe(false);

    const c = await newCard(db, scope, 'Relay docs');
    await rpc(db, 'card_attach', {
      p_card_id: a.id,
      p_kind: 'card',
      p_target: c.id,
    });
    await rpc(db, 'card_detach', {
      p_card_id: a.id,
      p_kind: 'card',
      p_target: c.id,
    });
    expect(
      (await rowsBetween(db, a.id, c.id))[0]?.invalidated_at
    ).not.toBeNull();
  });

  test('old untyped card attachments are carried over as untyped relations', async () => {
    const { scope, db } = await board('assess-carry');
    const a = await newCard(db, scope, 'Relay keys');
    const b = await newCard(db, scope, 'Relay rollout');
    // The shape the store held before relations had types.
    psql(
      `insert into public.card_refs (card_id, scope, kind, target, attached_by) ` +
        `select '${b.id}', scope, 'card', '${a.id}', created_by ` +
        `from public.cards where id = '${b.id}'`
    );
    expect(psql('select private.card_links_carry_refs()')).toBe('1');

    expect(await rowsBetween(db, a.id, b.id)).toEqual([
      expect.objectContaining({
        type: 'relates_to',
        declared: false,
        reason: 'carried over from an untyped attachment',
      }),
    ]);
    expect(
      psql(
        `select count(*) from public.card_refs where kind = 'card' and card_id = '${b.id}'`
      )
    ).toBe('0');
  });
});
