/**
 * The branch store at the level a direct PostgREST call meets it: a card
 * records the git branches its work ran on, a branch is visible exactly where
 * its card is, and a malformed branch never reaches the table.
 */
import { spawnSync } from 'node:child_process';

import { expect, test } from '@playwright/test';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import { e2eEnv } from '../helpers/env.js';
import { firstJson, McpTestClient } from '../helpers/mcp.js';
import { readSeedState } from '../helpers/runtime-state.js';
import { passwordGrantToken } from '../helpers/users.js';

const REPO = 'acme/memory-service';

interface CardJson {
  id: string;
  number: number;
  scope: string;
  state: string;
}

interface LandingJson {
  squash_sha: string;
  target: string | null;
  landed_at: string;
}

interface BranchJson {
  repo: string;
  branch: string;
  state: string;
  squash_sha: string | null;
  target: string | null;
  landed_at: string | null;
  landings: LandingJson[];
}

interface EventJson {
  type: string;
  from_state: string | null;
  to_state: string | null;
  reason: string | null;
  ref_kind: string | null;
  ref_target: string | null;
  branch_note: string | null;
  squash_sha: string | null;
  target_branch: string | null;
}

interface CardGetJson {
  error?: string;
  card: CardJson;
  branches: BranchJson[];
  events: EventJson[];
}

const asUser = (token: string): SupabaseClient =>
  createClient(e2eEnv.supabaseUrl, e2eEnv.supabaseAnonKey, {
    auth: { persistSession: false },
    global: { headers: { Authorization: `Bearer ${token}` } },
  });

/** A project scope the caller may write, made the way an agent makes one. */
const projectScope = async (token: string, tag: string): Promise<string> => {
  const agent = await McpTestClient.connect(token);
  try {
    const made = await agent.callTool('remember', {
      content: `e2e branch store marker ${tag}: the ingest worker drops chunks under load`,
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

test.describe('Card branches in the store', () => {
  test('a branch attaches once, reads back with its card, and detaches', async () => {
    const seed = await readSeedState();
    const token = await passwordGrantToken(seed.userA);
    const scope = await projectScope(token, `branch-store-${Date.now()}`);
    const db = asUser(token);
    const { card } = await rpc<{ card: CardJson }>(db, 'card_create', {
      p_scope: scope,
      p_title: 'Page the memory feed',
    });

    const target = `${REPO}:feature/feed-pages`;
    const first = await rpc<{ changed: boolean }>(db, 'card_attach', {
      p_card_id: card.id,
      p_kind: 'branch',
      p_target: target,
    });
    expect(first.changed).toBe(true);
    const again = await rpc<{ changed: boolean }>(db, 'card_attach', {
      p_card_id: card.id,
      p_kind: 'branch',
      p_target: target,
    });
    expect(again.changed).toBe(false);

    const read = await rpc<CardGetJson>(db, 'card_get', {
      p_card_id: card.id,
    });
    expect(read.branches).toEqual([
      expect.objectContaining({
        repo: REPO,
        branch: 'feature/feed-pages',
        state: 'open',
        squash_sha: null,
        target: null,
        landed_at: null,
      }),
    ]);
    expect(read.events.filter((event) => event.type === 'attached')).toEqual([
      expect.objectContaining({ ref_kind: 'branch', ref_target: target }),
    ]);
    // Every event carries the new columns, empty where they do not apply.
    for (const event of read.events) {
      expect(event).toMatchObject({
        branch_note: null,
        squash_sha: null,
        target_branch: null,
      });
    }

    for (const malformed of [
      'no-colon-here',
      `${REPO}:feature/has space`,
      `${REPO}:feature/a..b`,
      'owner name:feature/x',
      `${REPO}:`,
    ]) {
      const refused = await rpc<{ error?: string }>(db, 'card_attach', {
        p_card_id: card.id,
        p_kind: 'branch',
        p_target: malformed,
      });
      expect(refused.error, malformed).toBe('invalid');
    }

    const detached = await rpc<{ error?: string }>(db, 'card_detach', {
      p_card_id: card.id,
      p_kind: 'branch',
      p_target: target,
    });
    expect(detached.error).toBeUndefined();
    const after = await rpc<CardGetJson>(db, 'card_get', {
      p_card_id: card.id,
    });
    expect(after.branches).toEqual([]);
    expect(after.events.at(-1)).toMatchObject({
      type: 'detached',
      ref_kind: 'branch',
      ref_target: target,
    });
    const gone = await rpc<{ error?: string }>(db, 'card_detach', {
      p_card_id: card.id,
      p_kind: 'branch',
      p_target: target,
    });
    expect(gone.error).toBe('not_attached');
  });

  test('a stranger sees no branch of a card they cannot see, and cannot add one', async () => {
    const seed = await readSeedState();
    const ownerToken = await passwordGrantToken(seed.userA);
    const scope = await projectScope(ownerToken, `branch-rls-${Date.now()}`);
    const owner = asUser(ownerToken);
    const { card } = await rpc<{ card: CardJson }>(owner, 'card_create', {
      p_scope: scope,
      p_title: 'Rotate the edge certificates',
    });
    await rpc(owner, 'card_attach', {
      p_card_id: card.id,
      p_kind: 'branch',
      p_target: `${REPO}:feature/certs`,
    });

    const stranger = asUser(await passwordGrantToken(seed.userB));
    const peek = await stranger
      .from('card_branches')
      .select('*')
      .eq('card_id', card.id);
    expect(peek.error).toBeNull();
    expect(peek.data).toEqual([]);

    const read = await rpc<{ error?: string }>(stranger, 'card_get', {
      p_card_id: card.id,
    });
    expect(read.error).toBe('not_found');
    const added = await rpc<{ error?: string }>(stranger, 'card_attach', {
      p_card_id: card.id,
      p_kind: 'branch',
      p_target: `${REPO}:feature/forged`,
    });
    expect(added.error).toBe('not_found');

    const forged = await stranger.from('card_branches').insert({
      card_id: card.id,
      scope,
      repo: REPO,
      branch: 'feature/forged',
    });
    expect(forged.error).not.toBeNull();
  });
});

test.describe('A branch belongs to its card', () => {
  test("a branch row cannot claim a scope other than its card's", async () => {
    const seed = await readSeedState();
    const token = await passwordGrantToken(seed.userA);
    // Two projects this user may write: a row written in one must not
    // attach to a card of the other, or a writer of any scope could plant an
    // open branch on a card they may only read.
    const own = await projectScope(token, `branch-own-${Date.now()}`);
    const other = await projectScope(token, `branch-other-${Date.now()}`);
    const db = asUser(token);
    const { card } = await rpc<{ card: CardJson }>(db, 'card_create', {
      p_scope: other,
      p_title: 'A card in the other project',
    });

    const planted = await db.from('card_branches').insert({
      card_id: card.id,
      scope: own,
      repo: REPO,
      branch: 'feature/planted',
    });
    expect(planted.error).not.toBeNull();

    // A row recorded properly cannot be moved to another scope or card later.
    await rpc(db, 'card_attach', {
      p_card_id: card.id,
      p_kind: 'branch',
      p_target: `${REPO}:feature/real`,
    });
    const moved = await db
      .from('card_branches')
      .update({ scope: own })
      .eq('card_id', card.id)
      .eq('branch', 'feature/real')
      .select('*');
    expect(moved.error).not.toBeNull();

    const read = await rpc<CardGetJson>(db, 'card_get', {
      p_card_id: card.id,
    });
    expect(read.branches.map((branch) => branch.branch)).toEqual([
      'feature/real',
    ]);
  });
});

/** One statement against the e2e database, as the migration tests run it. */
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
      '-tA',
      '-c',
      query,
    ],
    { encoding: 'utf8' }
  );
  if (result.status !== 0) {
    throw new Error(`psql failed: ${result.stderr}`);
  }
  return (result.stdout ?? '').trim();
};

test.describe('The branch rule in the store', () => {
  test('work enters active with its branch, a stated reason for none, or a branch already open', async () => {
    const seed = await readSeedState();
    const token = await passwordGrantToken(seed.userA);
    const scope = await projectScope(token, `branch-enter-${Date.now()}`);
    const db = asUser(token);

    // Opening straight into active needs the branch or a declaration.
    const bare = await rpc<{ error?: string; message?: string }>(
      db,
      'card_create',
      { p_scope: scope, p_title: 'Starts running', p_state: 'active' }
    );
    expect(bare.error).toBe('branch_required');
    expect(bare.message).toMatch(/branch/u);

    const both = await rpc<{ error?: string }>(db, 'card_create', {
      p_scope: scope,
      p_title: 'Both at once',
      p_state: 'active',
      p_branch_repo: REPO,
      p_branch_name: 'feature/x',
      p_no_branch: 'research only',
    });
    expect(both.error).toBe('invalid');

    const idea = await rpc<{ error?: string }>(db, 'card_create', {
      p_scope: scope,
      p_title: 'A branch on an idea',
      p_branch_repo: REPO,
      p_branch_name: 'feature/x',
    });
    expect(idea.error).toBe('invalid');

    const withBranch = await rpc<{ card: CardJson }>(db, 'card_create', {
      p_scope: scope,
      p_title: 'Page the feed',
      p_state: 'active',
      p_branch_repo: REPO,
      p_branch_name: 'feature/feed-pages',
    });
    expect(withBranch.card.state).toBe('active');
    const opened = await rpc<CardGetJson>(db, 'card_get', {
      p_card_id: withBranch.card.id,
    });
    expect(opened.branches).toEqual([
      expect.objectContaining({ branch: 'feature/feed-pages', state: 'open' }),
    ]);
    expect(opened.events.map((event) => event.type)).toEqual([
      'created',
      'attached',
    ]);

    const noCode = await rpc<{ card: CardJson }>(db, 'card_create', {
      p_scope: scope,
      p_title: 'Measure the recall gap',
      p_state: 'active',
      p_no_branch: 'a measurement on the review stand, no code',
    });
    const declared = await rpc<CardGetJson>(db, 'card_get', {
      p_card_id: noCode.card.id,
    });
    expect(declared.events[0]).toMatchObject({
      type: 'created',
      branch_note: 'a measurement on the review stand, no code',
    });
    expect(declared.branches).toEqual([]);

    // A move into active meets the same rule.
    const { card } = await rpc<{ card: CardJson }>(db, 'card_create', {
      p_scope: scope,
      p_title: 'Idea first',
    });
    const refused = await rpc<{ error?: string }>(db, 'card_move', {
      p_card_id: card.id,
      p_to_state: 'active',
      p_reason: 'picking it up',
    });
    expect(refused.error).toBe('branch_required');
    const moved = await rpc<{ card: CardJson }>(db, 'card_move', {
      p_card_id: card.id,
      p_to_state: 'active',
      p_reason: 'picking it up',
      p_branch_repo: REPO,
      p_branch_name: 'feature/idea-first',
    });
    expect(moved.card.state).toBe('active');
    const events = (
      await rpc<CardGetJson>(db, 'card_get', { p_card_id: card.id })
    ).events;
    expect(events.map((event) => event.type)).toEqual([
      'created',
      'attached',
      'moved',
    ]);

    // Back from waiting to active on the SAME open branch needs nothing new.
    await rpc(db, 'card_move', {
      p_card_id: card.id,
      p_to_state: 'waiting',
      p_reason: 'review',
      p_not_landed: 'in review, not squashed yet',
    });
    const resumed = await rpc<{ error?: string; card?: CardJson }>(
      db,
      'card_move',
      {
        p_card_id: card.id,
        p_to_state: 'active',
        p_reason: 'review fixes on the same branch',
      }
    );
    expect(resumed.error).toBeUndefined();
    expect(resumed.card?.state).toBe('active');
  });

  test('work leaves active only by landing its branch or saying why it has not', async () => {
    const seed = await readSeedState();
    const token = await passwordGrantToken(seed.userA);
    const scope = await projectScope(token, `branch-leave-${Date.now()}`);
    const db = asUser(token);
    const { card } = await rpc<{ card: CardJson }>(db, 'card_create', {
      p_scope: scope,
      p_title: 'Swap the embedding model',
      p_state: 'active',
      p_branch_repo: REPO,
      p_branch_name: 'feature/embeddings',
    });

    const blocked = await rpc<{ error?: string; message?: string }>(
      db,
      'card_move',
      {
        p_card_id: card.id,
        p_to_state: 'waiting',
        p_reason: 'done from my side',
      }
    );
    expect(blocked.error).toBe('branch_open');
    expect(blocked.message).toContain(`${REPO}:feature/embeddings`);
    expect(blocked.message).toMatch(/land/u);

    const notLanded = await rpc<{ error?: string }>(db, 'card_move', {
      p_card_id: card.id,
      p_to_state: 'waiting',
      p_reason: 'waiting for the model to publish its vector size',
      p_not_landed:
        'the branch waits for the vector size, nothing to squash yet',
    });
    expect(notLanded.error).toBeUndefined();
    const moved = (
      await rpc<CardGetJson>(db, 'card_get', { p_card_id: card.id })
    ).events.at(-1);
    expect(moved).toMatchObject({
      type: 'moved',
      branch_note:
        'the branch waits for the vector size, nothing to squash yet',
    });

    // A declaration with nothing to declare is refused, not recorded.
    const { card: plain } = await rpc<{ card: CardJson }>(db, 'card_create', {
      p_scope: scope,
      p_title: 'Plain idea',
    });
    const stray = await rpc<{ error?: string }>(db, 'card_move', {
      p_card_id: plain.id,
      p_to_state: 'parked',
      p_reason: 'later',
      p_not_landed: 'nothing open',
    });
    expect(stray.error).toBe('invalid');

    // Landing records the commit and moves the card, by default to waiting.
    await rpc(db, 'card_move', {
      p_card_id: card.id,
      p_to_state: 'active',
      p_reason: 'the size is published',
    });
    const landed = await rpc<{ card: CardJson; changed: boolean }>(
      db,
      'card_land',
      {
        p_card_id: card.id,
        p_repo: REPO,
        p_branch: 'feature/embeddings',
        p_squash_sha: 'ABCDEF1',
        p_target: 'main',
        p_reason: 'full e2e green; waits for the release',
      }
    );
    expect(landed.changed).toBe(true);
    expect(landed.card.state).toBe('waiting');
    const after = await rpc<CardGetJson>(db, 'card_get', {
      p_card_id: card.id,
    });
    expect(after.branches).toEqual([
      expect.objectContaining({
        branch: 'feature/embeddings',
        state: 'landed',
        squash_sha: 'abcdef1',
        target: 'main',
      }),
    ]);
    const tail = after.events.slice(-2);
    expect(tail[0]).toMatchObject({
      type: 'landed',
      ref_kind: 'branch',
      ref_target: `${REPO}:feature/embeddings`,
      squash_sha: 'abcdef1',
      target_branch: 'main',
      reason: null,
    });
    expect(tail[1]).toMatchObject({
      type: 'moved',
      from_state: 'active',
      to_state: 'waiting',
      reason: 'full e2e green; waits for the release',
    });

    // The same landing again, short or full sha, changes nothing and writes
    // nothing.
    const count = after.events.length;
    for (const sha of ['abcdef1', 'abcdef1234567890abcdef1234567890abcdef12']) {
      const again = await rpc<{ changed: boolean }>(db, 'card_land', {
        p_card_id: card.id,
        p_repo: REPO,
        p_branch: 'feature/embeddings',
        p_squash_sha: sha,
        p_target: 'main',
        p_reason: 'retry',
      });
      expect(again.changed).toBe(false);
    }
    expect(
      (await rpc<CardGetJson>(db, 'card_get', { p_card_id: card.id })).events
    ).toHaveLength(count);

    // A landed branch alone does not carry the card back into active: the
    // move has to name the branch it works on again.
    const reentry = await rpc<{ error?: string }>(db, 'card_move', {
      p_card_id: card.id,
      p_to_state: 'active',
      p_reason: 'follow-up',
    });
    expect(reentry.error).toBe('branch_required');

    // Naming the landed branch reopens it: its code is being debugged again,
    // the landing it made stays on record, and the reopening is one more
    // entry of work with the branch in the history.
    const reopened = await rpc<{ card: CardJson; error?: string }>(
      db,
      'card_move',
      {
        p_card_id: card.id,
        p_to_state: 'active',
        p_reason: 'the landed search misses deleted rows; fixing it here',
        p_branch_repo: REPO,
        p_branch_name: 'feature/embeddings',
      }
    );
    expect(reopened.error).toBeUndefined();
    expect(reopened.card.state).toBe('active');
    const open = await rpc<CardGetJson>(db, 'card_get', {
      p_card_id: card.id,
    });
    expect(open.branches).toEqual([
      expect.objectContaining({
        branch: 'feature/embeddings',
        state: 'open',
        squash_sha: null,
        target: null,
        landings: [expect.objectContaining({ squash_sha: 'abcdef1' })],
      }),
    ]);
    expect(open.events.slice(-2)).toEqual([
      expect.objectContaining({
        type: 'attached',
        ref_kind: 'branch',
        ref_target: `${REPO}:feature/embeddings`,
      }),
      expect.objectContaining({
        type: 'moved',
        from_state: 'waiting',
        to_state: 'active',
      }),
    ]);

    // The next squash lands the branch again, beside the first landing.
    const relanded = await rpc<{ card: CardJson; changed: boolean }>(
      db,
      'card_land',
      {
        p_card_id: card.id,
        p_repo: REPO,
        p_branch: 'feature/embeddings',
        p_squash_sha: 'fedcba9',
        p_target: 'main',
        p_reason: 'the fix is green',
      }
    );
    expect(relanded.changed).toBe(true);
    const twice = await rpc<CardGetJson>(db, 'card_get', {
      p_card_id: card.id,
    });
    expect(twice.branches).toEqual([
      expect.objectContaining({
        state: 'landed',
        squash_sha: 'fedcba9',
        landings: [
          expect.objectContaining({ squash_sha: 'abcdef1' }),
          expect.objectContaining({ squash_sha: 'fedcba9' }),
        ],
      }),
    ]);
  });

  test('a forgotten landing is recorded from any state but the archive', async () => {
    const seed = await readSeedState();
    const token = await passwordGrantToken(seed.userA);
    const scope = await projectScope(token, `branch-late-${Date.now()}`);
    const db = asUser(token);
    const { card } = await rpc<{ card: CardJson }>(db, 'card_create', {
      p_scope: scope,
      p_title: 'Shipped long ago',
    });
    await rpc(db, 'card_move', {
      p_card_id: card.id,
      p_to_state: 'waiting',
      p_reason: 'someone moved it by hand',
    });

    const late = await rpc<{ card: CardJson }>(db, 'card_land', {
      p_card_id: card.id,
      p_repo: REPO,
      p_branch: 'feature/old-work',
      p_squash_sha: '1234567',
      p_target: 'main',
      p_reason: 'released in 0.20.0 and accepted',
      p_to_state: 'done',
    });
    expect(late.card.state).toBe('done');

    // Landing in place: no move, and the reason stays on the landing itself.
    const { card: stay } = await rpc<{ card: CardJson }>(db, 'card_create', {
      p_scope: scope,
      p_title: 'Already waiting',
    });
    await rpc(db, 'card_move', {
      p_card_id: stay.id,
      p_to_state: 'waiting',
      p_reason: 'set by hand',
    });
    await rpc(db, 'card_land', {
      p_card_id: stay.id,
      p_repo: REPO,
      p_branch: 'feature/in-place',
      p_squash_sha: '7654321',
      p_target: 'main',
      p_reason: 'recorded late, still waiting for the release',
    });
    const stayed = await rpc<CardGetJson>(db, 'card_get', {
      p_card_id: stay.id,
    });
    expect(stayed.card.state).toBe('waiting');
    expect(stayed.events.at(-1)).toMatchObject({
      type: 'landed',
      reason: 'recorded late, still waiting for the release',
    });

    // Archiving is not a move: an open branch does not hold a card on the
    // board.
    const { card: dropped } = await rpc<{ card: CardJson }>(db, 'card_create', {
      p_scope: scope,
      p_title: 'Abandoned',
      p_state: 'active',
      p_branch_repo: REPO,
      p_branch_name: 'feature/abandoned',
    });
    const abandoned = await rpc<{ error?: string }>(db, 'card_archive', {
      p_card_id: dropped.id,
      p_reason: 'abandoned before it landed',
    });
    expect(abandoned.error).toBeUndefined();

    await rpc(db, 'card_archive', {
      p_card_id: stay.id,
      p_reason: 'folded elsewhere',
    });
    const archived = await rpc<{ error?: string }>(db, 'card_land', {
      p_card_id: stay.id,
      p_repo: REPO,
      p_branch: 'feature/another',
      p_squash_sha: '89abcde',
      p_target: 'main',
      p_reason: 'too late',
    });
    expect(archived.error).toBe('archived');

    for (const [field, value] of [
      ['p_squash_sha', 'xyz'],
      ['p_target', 'main branch'],
      ['p_repo', 'a b'],
    ] as const) {
      const bad = await rpc<{ error?: string }>(db, 'card_land', {
        p_card_id: card.id,
        p_repo: REPO,
        p_branch: 'feature/old-work',
        p_squash_sha: '1234567',
        p_target: 'main',
        p_reason: 'x',
        [field]: value,
      });
      expect(bad.error, field).toBe('invalid');
    }

    const stranger = asUser(await passwordGrantToken(seed.userB));
    const foreign = await rpc<{ error?: string }>(stranger, 'card_land', {
      p_card_id: card.id,
      p_repo: REPO,
      p_branch: 'feature/x',
      p_squash_sha: '1234567',
      p_target: 'main',
      p_reason: 'not mine',
    });
    expect(foreign.error).toBe('not_found');
  });

  test('a branch that lands again keeps every landing, and an earlier one recorded again changes nothing', async () => {
    // A bug found on main is fixed in the branch that brought it, and that
    // branch is squashed again — so one branch can land more than once.
    const seed = await readSeedState();
    const token = await passwordGrantToken(seed.userA);
    const scope = await projectScope(token, `branch-reland-${Date.now()}`);
    const db = asUser(token);
    const { card } = await rpc<{ card: CardJson }>(db, 'card_create', {
      p_scope: scope,
      p_title: 'Fixed in the branch that brought it',
    });
    await rpc(db, 'card_move', {
      p_card_id: card.id,
      p_to_state: 'waiting',
      p_reason: 'set by hand',
    });
    const land = (branch: string, sha: string, reason: string) =>
      rpc<{ changed: boolean; error?: string }>(db, 'card_land', {
        p_card_id: card.id,
        p_repo: REPO,
        p_branch: branch,
        p_squash_sha: sha,
        p_target: 'main',
        p_reason: reason,
      });

    expect(
      (await land('feature/relanded', 'aaaaaaa', 'the feature')).changed
    ).toBe(true);
    expect(
      (
        await land(
          'feature/relanded',
          'bbbbbbb',
          'the fix, from the same branch'
        )
      ).changed
    ).toBe(true);
    expect(
      (await land('feature/other', 'ccccccc', 'another branch')).changed
    ).toBe(true);

    const read = await rpc<CardGetJson>(db, 'card_get', { p_card_id: card.id });
    const relanded = read.branches.find((b) => b.branch === 'feature/relanded');
    const other = read.branches.find((b) => b.branch === 'feature/other');
    // The row keeps the latest landing; the landings keep all of them, oldest
    // first, and each branch only its own.
    expect(relanded).toMatchObject({ state: 'landed', squash_sha: 'bbbbbbb' });
    expect(relanded?.landings.map((l) => l.squash_sha)).toEqual([
      'aaaaaaa',
      'bbbbbbb',
    ]);
    expect(relanded?.landings[0]).toMatchObject({ target: 'main' });
    expect(relanded?.landings[0]?.landed_at).toBeTruthy();
    expect(other?.landings.map((l) => l.squash_sha)).toEqual(['ccccccc']);

    // Recording the earlier squash again — say, from a reminder that could
    // not see the later one — is already on record, by a short or a longer
    // sha, and must not wind the row back to it.
    const again = await land(
      'feature/relanded',
      'aaaaaaa1234',
      'recorded again'
    );
    expect(again.error).toBeUndefined();
    expect(again.changed).toBe(false);
    const after = await rpc<CardGetJson>(db, 'card_get', {
      p_card_id: card.id,
    });
    const kept = after.branches.find((b) => b.branch === 'feature/relanded');
    expect(kept?.squash_sha).toBe('bbbbbbb');
    expect(kept?.landings).toHaveLength(2);
    expect(after.events.filter((e) => e.type === 'landed')).toHaveLength(3);
  });

  test('the old six-argument move still resolves, and each command keeps one signature', async () => {
    const seed = await readSeedState();
    const token = await passwordGrantToken(seed.userA);
    const scope = await projectScope(token, `branch-compat-${Date.now()}`);
    const db = asUser(token);
    const { card } = await rpc<{ card: CardJson }>(db, 'card_create', {
      p_scope: scope,
      p_title: 'Compat',
    });
    // Exactly the arguments the previous server sends, by name.
    const moved = await rpc<{ card: CardJson }>(db, 'card_move', {
      p_card_id: card.id,
      p_to_state: 'waiting',
      p_reason: 'as the previous server calls it',
      p_thread: null,
      p_agent_label: 'old-server',
      p_idempotency_key: `compat-${Date.now()}`,
    });
    expect(moved.card.state).toBe('waiting');

    expect(
      psql(
        "select proname || '=' || count(*) from pg_proc " +
          "where pronamespace = 'public'::regnamespace and proname in " +
          "('card_move', 'card_create', 'card_promote_loop', 'card_land') " +
          'group by proname order by proname'
      )
    ).toBe(
      [
        'card_create=1',
        'card_land=1',
        'card_move=1',
        'card_promote_loop=1',
      ].join('\n')
    );
  });

  test('a briefing names the open branches of the project', async () => {
    const seed = await readSeedState();
    const token = await passwordGrantToken(seed.userA);
    const scope = await projectScope(token, `branch-brief-${Date.now()}`);
    const db = asUser(token);
    const { card } = await rpc<{ card: CardJson }>(db, 'card_create', {
      p_scope: scope,
      p_title: 'Named in the briefing',
      p_state: 'active',
      p_branch_repo: REPO,
      p_branch_name: 'feature/briefed',
    });
    const work = await rpc<{
      open_branches: Array<{
        card_id: string;
        number: number;
        state: string;
        repo: string;
        branch: string;
        landings: Array<{ squash_sha: string }>;
      }>;
    }>(db, 'briefing_work', { p_scope: scope });
    expect(work.open_branches).toEqual([
      {
        card_id: card.id,
        number: card.number,
        state: 'active',
        repo: REPO,
        branch: 'feature/briefed',
        landings: [],
      },
    ]);
  });

  test('another card may reopen a landed branch, and the briefing carries its landings', async () => {
    const seed = await readSeedState();
    const token = await passwordGrantToken(seed.userA);
    const scope = await projectScope(token, `branch-reopen-${Date.now()}`);
    const db = asUser(token);

    const { card: first } = await rpc<{ card: CardJson }>(db, 'card_create', {
      p_scope: scope,
      p_title: 'Brought the search',
      p_state: 'active',
      p_branch_repo: REPO,
      p_branch_name: 'feature/search',
    });
    await rpc(db, 'card_land', {
      p_card_id: first.id,
      p_repo: REPO,
      p_branch: 'feature/search',
      p_squash_sha: '1111111',
      p_target: 'main',
      p_reason: 'green',
    });

    // The branch that brought a bug is where the bug is fixed, even when the
    // fix is another card's work.
    const { card: second, error } = await rpc<{
      card: CardJson;
      error?: string;
    }>(db, 'card_create', {
      p_scope: scope,
      p_title: 'Search misses deleted rows',
      p_state: 'active',
      p_branch_repo: REPO,
      p_branch_name: 'feature/search',
    });
    expect(error).toBeUndefined();

    // The branch is open for the second card, and the briefing says which
    // squashes of it the board already holds, so the one on main is not
    // mistaken for a landing nobody recorded.
    const work = await rpc<{
      open_branches: Array<{
        card_id: string;
        branch: string;
        landings: Array<{ squash_sha: string }>;
      }>;
    }>(db, 'briefing_work', { p_scope: scope });
    expect(work.open_branches).toEqual([
      expect.objectContaining({
        card_id: second.id,
        branch: 'feature/search',
        landings: [{ squash_sha: '1111111' }],
      }),
    ]);
  });
});
