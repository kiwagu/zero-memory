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
import { entityIdOf, passwordGrantToken } from '../helpers/users.js';

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
 * then starts from a clean slate.
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
  ear.heard.length = 0;
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
    const tokenB = await passwordGrantToken(seed.userB);
    const readerA = await entityIdOf(seed.userA.id);
    const scope = await projectScope(
      tokenA,
      `live-member-${Date.now()}`,
      markers
    );
    const readerB = await makeMember(scope, seed.userB.id, 'writer');

    const member = await listen(tokenB, readerB);
    try {
      expect(member.status).toBe('SUBSCRIBED');
      await untilLive(member, () =>
        write(tokenB, {
          content: `live-refresh poke ${Date.now()}`,
          scope: personal(readerB),
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
      await expect.poll(memoryNudges, { timeout: 15_000 }).toBe(1);
      const { error } = await asUser(tokenA)
        .from('memories')
        .update({
          invalidated_at: new Date().toISOString(),
          invalidated_by: readerA,
        })
        .eq('id', shared);
      expect(error).toBeNull();
      await expect.poll(memoryNudges, { timeout: 15_000 }).toBe(2);
    } finally {
      await member.close();
    }
  });
});
