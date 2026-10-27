/**
 * Live refresh: every reader has one private channel, `reader:<their id>`,
 * and the store nudges it whenever something that reader can see changes.
 * A nudge carries no content, only what changed: `memories` or `board`. The
 * page that hears it fetches again under row-level security, so the channel
 * never decides what a reader sees, only when to look again.
 */
import { expect, test } from '@playwright/test';
import { createClient, type RealtimeChannel } from '@supabase/supabase-js';

import { e2eEnv } from '../helpers/env.js';
import {
  admin,
  asUser,
  makeMember,
  projectScope,
  rpc,
} from '../helpers/board-store.js';
import { readSeedState } from '../helpers/runtime-state.js';
import {
  entityIdOf,
  passwordGrantToken,
  provisionE2EUser,
} from '../helpers/users.js';

const NUDGES = ['memories', 'board'] as const;
type Nudge = (typeof NUDGES)[number];

const markers: string[] = [];

test.afterAll(async () => {
  if (markers.length > 0) {
    await admin().from('memories').delete().in('id', markers);
  }
});

/**
 * Joins `reader:<readerId>` as the holder of `token`, and answers what it
 * hears plus how the join ended. The socket carries the token, so the store's
 * policy decides whether the join is admitted.
 */
const listen = async (token: string, readerId: string) => {
  const client = createClient(e2eEnv.supabaseUrl, e2eEnv.supabaseAnonKey, {
    auth: { persistSession: false },
  });
  await client.realtime.setAuth(token);
  const heard: Nudge[] = [];
  const channel: RealtimeChannel = client.channel(`reader:${readerId}`, {
    config: { private: true },
  });
  for (const event of NUDGES) {
    channel.on('broadcast', { event }, () => heard.push(event));
  }
  const status = await new Promise<string>((resolve) => {
    const timer = setTimeout(() => resolve('TIMED_OUT'), 10_000);
    channel.subscribe((state) => {
      if (state !== 'CLOSED') {
        clearTimeout(timer);
        resolve(state);
      }
    });
  });
  return {
    status,
    heard,
    close: async () => {
      await client.removeChannel(channel);
    },
  };
};

/** A memory written through the API as the holder of `token`. */
const write = async (
  token: string,
  values: Record<string, unknown>
): Promise<string> => {
  const { data, error } = await asUser(token)
    .from('memories')
    .insert({ kind: 'fact', ...values })
    .select('id')
    .single();
  expect(error).toBeNull();
  const id = (data as { id: string }).id;
  markers.push(id);
  return id;
};

/**
 * Broadcast from the database starts reaching a listener a few seconds after
 * it joins, and a change written before that is not delivered. So a spec
 * pokes with a harmless write of the listener's own until it hears anything,
 * waits until the pokes stop arriving, then starts from a clean slate.
 */
const untilLive = async (
  ear: Awaited<ReturnType<typeof listen>>,
  poke: () => Promise<unknown>
) => {
  await expect
    .poll(
      async () => {
        if (ear.heard.length === 0) {
          await poke();
        }
        return ear.heard.length;
      },
      { intervals: [1000], timeout: 30_000 }
    )
    .toBeGreaterThan(0);
  let before = -1;
  await expect
    .poll(
      () => {
        const settled = ear.heard.length === before;
        before = ear.heard.length;
        return settled;
      },
      { intervals: [2000], timeout: 20_000 }
    )
    .toBe(true);
  ear.heard.length = 0;
};

/**
 * A reader of their own, so nothing another spec writes for the seeded users
 * reaches the channel under test.
 */
const freshReader = async (tag: string) => {
  const user = await provisionE2EUser(
    `live-${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@zm.e2e`
  );
  return {
    user,
    id: await entityIdOf(user.id),
    token: await passwordGrantToken(user),
  };
};

const personal = (readerId: string): string =>
  `user.${readerId.replaceAll('.', '_')}`;

test.describe('Each reader hears their own channel', () => {
  test('a reader hears their own memory and card changes, and no one else may listen', async () => {
    const seed = await readSeedState();
    const tokenA = await passwordGrantToken(seed.userA);
    const tokenB = await passwordGrantToken(seed.userB);
    const readerA = await entityIdOf(seed.userA.id);
    const scope = await projectScope(tokenA, `live-own-${Date.now()}`, markers);

    const owner = await listen(tokenA, readerA);
    const intruder = await listen(tokenB, readerA);
    try {
      expect(owner.status).toBe('SUBSCRIBED');
      await untilLive(owner, () =>
        write(tokenA, {
          content: `live-refresh poke ${Date.now()}`,
          scope: personal(readerA),
          visibility: 'private',
        })
      );

      await write(tokenA, {
        content: `live-refresh own ${Date.now()}: the relay drops frames`,
        scope: personal(readerA),
        visibility: 'private',
      });
      await rpc(asUser(tokenA), 'card_create', {
        p_scope: scope,
        p_title: 'Relay keys',
        p_type: 'task',
        p_state: 'idea',
        p_no_links: 'e2e fixture',
      });
      await expect
        .poll(() => [...new Set(owner.heard)].sort(), { timeout: 15_000 })
        .toEqual(['board', 'memories']);

      // Another reader's channel refuses the join, and hears nothing.
      expect(intruder.status).not.toBe('SUBSCRIBED');
      expect(intruder.heard).toEqual([]);
    } finally {
      await owner.close();
      await intruder.close();
    }
  });

  test("a member is nudged for another member's shared memory and its board, never for their private memory", async () => {
    const seed = await readSeedState();
    const tokenA = await passwordGrantToken(seed.userA);
    const readerA = await entityIdOf(seed.userA.id);
    const scope = await projectScope(
      tokenA,
      `live-member-${Date.now()}`,
      markers
    );
    const reader = await freshReader('member');
    await makeMember(scope, reader.user.id, 'writer');

    const member = await listen(reader.token, reader.id);
    try {
      expect(member.status).toBe('SUBSCRIBED');
      await untilLive(member, () =>
        write(reader.token, {
          content: `live-refresh poke ${Date.now()}`,
          scope: personal(reader.id),
          visibility: 'private',
        })
      );

      // A private memory in the shared scope, then a card as a sentinel.
      // Nudges on one channel arrive in order, so once the board's nudge is
      // here, a nudge for the private memory would have arrived before it.
      await write(tokenA, {
        content: `live-refresh private ${Date.now()}: only its owner sees it`,
        scope,
        visibility: 'private',
      });
      await rpc(asUser(tokenA), 'card_create', {
        p_scope: scope,
        p_title: 'Relay keys',
        p_type: 'task',
        p_state: 'idea',
        p_no_links: 'e2e fixture',
      });
      await expect
        .poll(() => member.heard, { timeout: 15_000 })
        .toContain('board');
      expect(member.heard).not.toContain('memories');

      // A shared memory is the member's news, and so is its retirement.
      const memoryNudges = () =>
        member.heard.filter((event) => event === 'memories').length;
      const shared = await write(tokenA, {
        content: `live-refresh shared ${Date.now()}: the team sees it`,
        scope,
        visibility: 'shared',
        shared_at: new Date().toISOString(),
        shared_by: readerA,
      });
      await expect
        .poll(memoryNudges, { timeout: 15_000 })
        .toBeGreaterThanOrEqual(1);
      const afterWrite = memoryNudges();
      const { error } = await asUser(tokenA)
        .from('memories')
        .update({
          invalidated_at: new Date().toISOString(),
          invalidated_by: readerA,
        })
        .eq('id', shared);
      expect(error).toBeNull();
      await expect
        .poll(memoryNudges, { timeout: 15_000 })
        .toBeGreaterThan(afterWrite);
    } finally {
      await member.close();
    }
  });

  test('a member of a scope below is nudged for a shared memory above it; a member not yet accepted is not', async () => {
    const seed = await readSeedState();
    const tokenA = await passwordGrantToken(seed.userA);
    const readerA = await entityIdOf(seed.userA.id);
    const scope = await projectScope(
      tokenA,
      `live-tree-${Date.now()}`,
      markers
    );

    // Membership of a scope below this one makes it visible; an invitation
    // not yet accepted makes nothing visible.
    const below = await freshReader('below');
    const invited = await freshReader('invited');
    const { error: joined } = await admin()
      .from('scope_members')
      .insert([
        {
          scope: `${scope}.team`,
          user_id: below.id,
          role: 'reader',
          accepted_at: new Date().toISOString(),
        },
        { scope, user_id: invited.id, role: 'reader', accepted_at: null },
      ]);
    expect(joined).toBeNull();
    // A board of the invited reader's own, for the sentinel below.
    const invitedBoard = await projectScope(
      invited.token,
      `live-tree-own-${Date.now()}`,
      markers
    );

    const belowEar = await listen(below.token, below.id);
    const invitedEar = await listen(invited.token, invited.id);
    try {
      for (const [ear, reader] of [
        [belowEar, below],
        [invitedEar, invited],
      ] as const) {
        expect(ear.status).toBe('SUBSCRIBED');
        await untilLive(ear, () =>
          write(reader.token, {
            content: `live-refresh poke ${Date.now()}`,
            scope: personal(reader.id),
            visibility: 'private',
          })
        );
      }

      await write(tokenA, {
        content: `live-refresh above ${Date.now()}: the team sees it`,
        scope,
        visibility: 'shared',
        shared_at: new Date().toISOString(),
        shared_by: readerA,
      });
      await expect
        .poll(() => belowEar.heard, { timeout: 15_000 })
        .toContain('memories');
      // A card on the invited reader's own board is the sentinel: once its
      // nudge is heard, a nudge for the shared memory would already be here.
      await rpc(asUser(invited.token), 'card_create', {
        p_scope: invitedBoard,
        p_title: 'Sentinel',
        p_type: 'task',
        p_state: 'idea',
        p_no_links: 'e2e fixture',
      });
      await expect
        .poll(() => invitedEar.heard, { timeout: 15_000 })
        .toContain('board');
      expect(invitedEar.heard).not.toContain('memories');
    } finally {
      await belowEar.close();
      await invitedEar.close();
    }
  });
});
