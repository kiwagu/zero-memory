/**
 * The release store at the level a direct PostgREST call meets it: a project
 * names where its production state lives, only its admin may say so, and a
 * url carrying credentials never reaches the table. A production state is
 * recorded once per card and version, and reads back on the card, the board
 * and the briefing.
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
      content: `e2e release store marker ${tag}: the ingest worker drops chunks under load`,
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

test.describe('Release settings in the store', () => {
  test('only a scope admin writes the setting; members read it; a bad url never lands', async () => {
    const seed = await readSeedState();
    const token = await passwordGrantToken(seed.userA);
    const scope = await projectScope(token, `release-settings-${Date.now()}`);
    const db = asUser(token);

    const empty = await db
      .from('scope_release_settings')
      .select('*')
      .eq('scope', scope);
    expect(empty.error).toBeNull();
    expect(empty.data).toEqual([]);

    // Someone outside the project cannot name its production.
    const stranger = asUser(await passwordGrantToken(seed.userB));
    const foreign = await stranger
      .from('scope_release_settings')
      .insert({ scope, version_url: 'https://evil.example.com/x' });
    expect(foreign.error).not.toBeNull();

    // The admin can, but never with credentials in the url.
    const leaky = await db
      .from('scope_release_settings')
      .insert({ scope, version_url: 'https://user:pw@example.com/healthz' });
    expect(leaky.error?.message).toMatch(/check constraint/u);

    for (const bad of [
      "select private.is_release_url('https://user:pw@example.com/healthz')",
      "select private.is_release_url('http://example.com/healthz')",
      "select private.is_release_url('ftp://example.com')",
    ]) {
      expect(psql(bad)).toBe('f');
    }
    for (const good of [
      "select private.is_release_url('https://api.example.com/healthz')",
      "select private.is_release_url('http://localhost:8788/healthz')",
      "select private.is_release_url('http://127.0.0.1:8788/healthz')",
    ]) {
      expect(psql(good)).toBe('t');
    }
  });
});

test.describe('Release commands in the store', () => {
  test('configure is the admin’s; settings read back; a bad field is refused whole', async () => {
    const seed = await readSeedState();
    const token = await passwordGrantToken(seed.userA);
    const scope = await projectScope(token, `release-config-${Date.now()}`);
    const db = asUser(token);

    const none = await rpc<{ settings: unknown }>(db, 'release_settings', {
      p_scope: scope,
    });
    expect(none.settings).toBeNull();

    const set = await rpc<{
      settings: { version_url: string; on_release: string };
    }>(db, 'release_configure', {
      p_scope: scope,
      p_version_url: 'https://api.example.com/healthz',
    });
    expect(set.settings).toMatchObject({
      version_url: 'https://api.example.com/healthz',
      tag_template: 'v{version}',
      on_release: 'record',
    });

    const bad = await rpc<{ error?: string }>(db, 'release_configure', {
      p_scope: scope,
      p_version_url: 'https://u:p@api.example.com/healthz',
    });
    expect(bad.error).toBe('invalid');
    const kept = await rpc<{ settings: { version_url: string } }>(
      db,
      'release_settings',
      { p_scope: scope }
    );
    expect(kept.settings.version_url).toBe('https://api.example.com/healthz');

    // Outside the project the scope does not exist; a writer who is not its
    // admin may record a release but not say where production lives.
    const tokenB = await passwordGrantToken(seed.userB);
    const asB = asUser(tokenB);
    const unseen = await rpc<{ error?: string }>(asB, 'release_configure', {
      p_scope: scope,
      p_version_url: 'https://evil.example.com/x',
    });
    expect(unseen.error).toBe('not_found');

    const userBId = psql(
      `select id from public.profiles where user_id = '${seed.userB.id}'`
    );
    await rpc(db, 'add_scope_member', {
      p_scope: scope,
      p_user: userBId,
      p_role: 'writer',
    });
    await rpc(asB, 'accept_scope_invitation', { p_scope: scope });

    const refused = await rpc<{ error?: string }>(asB, 'release_configure', {
      p_scope: scope,
      p_version_url: 'https://evil.example.com/x',
    });
    expect(refused.error).toBe('forbidden');
    const recorded = await rpc<{ release: { version: string } }>(
      asB,
      'release_record',
      {
        p_scope: scope,
        p_version: '0.1.0',
        p_build: null,
        p_release_commit: 'abcdef1',
        p_source: 'url',
        p_card_ids: [],
      }
    );
    expect(recorded.release.version).toBe('0.1.0');
  });

  test('a release is recorded once per card and version, and the first observer is kept', async () => {
    const seed = await readSeedState();
    const token = await passwordGrantToken(seed.userA);
    const scope = await projectScope(token, `release-record-${Date.now()}`);
    const db = asUser(token);
    const { card } = await rpc<{ card: CardJson }>(db, 'card_create', {
      p_scope: scope,
      p_title: 'Shipped work',
    });
    await rpc(db, 'card_move', {
      p_card_id: card.id,
      p_to_state: 'waiting',
      p_reason: 'set by hand',
    });
    await rpc(db, 'card_land', {
      p_card_id: card.id,
      p_repo: REPO,
      p_branch: 'feature/shipped',
      p_squash_sha: 'aaaaaaa',
      p_target: 'main',
      p_reason: 'landed',
    });

    const candidates = await rpc<{
      cards: Array<{ id: string; landings: unknown[] }>;
    }>(db, 'release_candidates', { p_scope: scope, p_version: '1.2.0' });
    expect(candidates.cards.map((c) => c.id)).toEqual([card.id]);
    expect(candidates.cards[0]?.landings).toEqual([
      { repo: REPO, branch: 'feature/shipped', squash_sha: 'aaaaaaa' },
    ]);

    const args = {
      p_scope: scope,
      p_version: '1.2.0',
      p_build: 'abc1234',
      p_release_commit: 'bbbbbbb',
      p_source: 'url',
      p_card_ids: [card.id],
    };
    const first = await rpc<{
      release: { first_observed: boolean };
      recorded: string[];
      moved: string[];
    }>(db, 'release_record', args);
    expect(first.release.first_observed).toBe(true);
    expect(first.recorded).toEqual([card.id]);
    expect(first.moved).toEqual([]);

    const again = await rpc<{
      release: { first_observed: boolean };
      recorded: string[];
    }>(db, 'release_record', args);
    expect(again.release.first_observed).toBe(false);
    expect(again.recorded).toEqual([]);

    const read = await rpc<
      CardGetJson & {
        card: CardJson & { state: string };
        releases: Array<{ version: string }>;
      }
    >(db, 'card_get', { p_card_id: card.id });
    expect(read.card.state).toBe('waiting');
    expect(read.releases.map((r) => r.version)).toEqual(['1.2.0']);
    expect(read.events.filter((e) => e.type === 'released')).toHaveLength(1);

    // Already released at this version: no longer a candidate.
    const after = await rpc<{ cards: unknown[] }>(db, 'release_candidates', {
      p_scope: scope,
      p_version: '1.2.0',
    });
    expect(after.cards).toEqual([]);

    const listed = await rpc<{
      cards: Array<{ id: string; released_in: string | null }>;
    }>(db, 'board_list', { p_scope: scope });
    expect(listed.cards.find((c) => c.id === card.id)?.released_in).toBe(
      '1.2.0'
    );
  });

  test('the policy switch moves carried waiting cards to done, and only them', async () => {
    const seed = await readSeedState();
    const token = await passwordGrantToken(seed.userA);
    const scope = await projectScope(token, `release-policy-${Date.now()}`);
    const db = asUser(token);
    await rpc(db, 'release_configure', {
      p_scope: scope,
      p_on_release: 'record_and_move_done',
    });
    const make = async (title: string, state: string) => {
      const { card } = await rpc<{ card: CardJson }>(db, 'card_create', {
        p_scope: scope,
        p_title: title,
      });
      if (state !== 'idea') {
        await rpc(db, 'card_move', {
          p_card_id: card.id,
          p_to_state: state,
          p_reason: 'set by hand',
        });
      }
      return card;
    };
    const waiting = await make('Waiting for the release', 'waiting');
    const parked = await make('Parked but carried', 'parked');
    const result = await rpc<{ moved: string[]; recorded: string[] }>(
      db,
      'release_record',
      {
        p_scope: scope,
        p_version: '2.0.0',
        p_build: null,
        p_release_commit: 'ccccccc',
        p_source: 'tag',
        p_card_ids: [waiting.id, parked.id],
      }
    );
    expect(result.recorded.sort()).toEqual([waiting.id, parked.id].sort());
    expect(result.moved).toEqual([waiting.id]);
    const moved = await rpc<{
      card: { state: string };
      events: Array<{ type: string; reason: string | null }>;
    }>(db, 'card_get', { p_card_id: waiting.id });
    expect(moved.card.state).toBe('done');
    expect(moved.events.at(-1)).toMatchObject({ type: 'moved' });
    expect(moved.events.at(-1)?.reason).toContain('2.0.0');
  });

  test('a record naming another scope’s card, or a bad sha, writes nothing', async () => {
    const seed = await readSeedState();
    const token = await passwordGrantToken(seed.userA);
    const db = asUser(token);
    const mine = await projectScope(token, `release-own-${Date.now()}`);
    const other = await projectScope(token, `release-other-${Date.now()}`);
    const { card } = await rpc<{ card: CardJson }>(db, 'card_create', {
      p_scope: other,
      p_title: 'Elsewhere',
    });

    const foreign = await rpc<{ recorded: string[] }>(db, 'release_record', {
      p_scope: mine,
      p_version: '3.0.0',
      p_build: null,
      p_release_commit: 'ddddddd',
      p_source: 'url',
      p_card_ids: [card.id],
    });
    expect(foreign.recorded).toEqual([]);

    const bad = await rpc<{ error?: string }>(db, 'release_record', {
      p_scope: mine,
      p_version: '3.0.1',
      p_build: null,
      p_release_commit: 'not-a-sha',
      p_source: 'url',
      p_card_ids: [],
    });
    expect(bad.error).toBe('invalid');
    expect(
      psql(
        `select count(*) from public.scope_releases where scope = '${mine}' and version = '3.0.1'`
      )
    ).toBe('0');
  });

  test('a briefing names the production state and the release of its cards', async () => {
    const seed = await readSeedState();
    const token = await passwordGrantToken(seed.userA);
    const scope = await projectScope(token, `release-brief-${Date.now()}`);
    const db = asUser(token);
    const { card } = await rpc<{ card: CardJson }>(db, 'card_create', {
      p_scope: scope,
      p_title: 'Briefed release',
    });
    await rpc(db, 'card_move', {
      p_card_id: card.id,
      p_to_state: 'waiting',
      p_reason: 'set by hand',
    });
    await rpc(db, 'release_record', {
      p_scope: scope,
      p_version: '4.1.0',
      p_build: 'feedbee',
      p_release_commit: 'eeeeeee',
      p_source: 'url',
      p_card_ids: [card.id],
    });
    const work = await rpc<{
      production: { version: string; build: string } | null;
      lead: Array<{ id: string; released_in: string | null }>;
    }>(db, 'briefing_work', { p_scope: scope });
    expect(work.production).toMatchObject({
      version: '4.1.0',
      build: 'feedbee',
    });
    expect(work.lead.find((c) => c.id === card.id)?.released_in).toBe('4.1.0');
  });
});
