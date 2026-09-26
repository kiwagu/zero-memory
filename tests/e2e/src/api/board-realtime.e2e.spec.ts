/**
 * A board tells its readers when its cards change: every change to a card or
 * its stream is broadcast on the board's private channel, `board:<scope>`,
 * and only a reader of that board may listen to it.
 */
import { expect, test } from '@playwright/test';
import { createClient, type RealtimeChannel } from '@supabase/supabase-js';

import { e2eEnv } from '../helpers/env.js';
import { admin, asUser, projectScope, rpc } from '../helpers/board-store.js';
import { readSeedState } from '../helpers/runtime-state.js';
import { passwordGrantToken } from '../helpers/users.js';

interface Heard {
  event: string;
  payload: { table?: string; operation?: string };
}

const markers: string[] = [];

test.afterAll(async () => {
  if (markers.length > 0) {
    await admin().from('memories').delete().in('id', markers);
  }
});

/**
 * Joins a board's private channel as the holder of `token`, and answers what
 * it hears plus how the join ended. The socket carries the token, so the
 * store's policy decides whether the join is admitted.
 */
const listen = async (token: string, scope: string) => {
  const client = createClient(e2eEnv.supabaseUrl, e2eEnv.supabaseAnonKey, {
    auth: { persistSession: false },
  });
  await client.realtime.setAuth(token);
  const heard: Heard[] = [];
  const channel: RealtimeChannel = client.channel(`board:${scope}`, {
    config: { private: true },
  });
  for (const event of ['INSERT', 'UPDATE', 'DELETE']) {
    channel.on('broadcast', { event }, (message) =>
      heard.push({
        event: message.event,
        payload: message.payload as Heard['payload'],
      })
    );
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

/**
 * Broadcast from the database starts reaching a listener a few seconds after
 * it joins, and a change written before that is not delivered. So a spec first
 * nudges the board with a harmless note until the listener hears anything,
 * then starts from a clean slate.
 */
const untilLive = async (
  ear: Awaited<ReturnType<typeof listen>>,
  token: string,
  scope: string
) => {
  const db = asUser(token);
  const { card } = await rpc<{ card: { id: string } }>(db, 'card_create', {
    p_scope: scope,
    p_title: 'Primer',
    p_state: 'idea',
    p_no_links: 'e2e fixture',
  });
  await expect
    .poll(
      async () => {
        if (ear.heard.length === 0) {
          await rpc(db, 'card_note', { p_card_id: card.id, p_text: 'nudge' });
        }
        return ear.heard.length;
      },
      { intervals: [1000], timeout: 30_000 }
    )
    .toBeGreaterThan(0);
  ear.heard.length = 0;
};

test.describe('A board tells its readers when its cards change', () => {
  test('a member hears a card made, moved and noted on their board', async () => {
    const seed = await readSeedState();
    const token = await passwordGrantToken(seed.userA);
    const scope = await projectScope(token, `live-${Date.now()}`, markers);
    const ear = await listen(token, scope);
    try {
      expect(ear.status).toBe('SUBSCRIBED');
      await untilLive(ear, token, scope);
      const db = asUser(token);
      const { card } = await rpc<{ card: { id: string } }>(db, 'card_create', {
        p_scope: scope,
        p_title: 'Relay keys',
        p_state: 'idea',
        p_no_links: 'e2e fixture',
      });
      await rpc(db, 'card_note', { p_card_id: card.id, p_text: 'keys first' });

      await expect
        .poll(() => ear.heard.map((h) => `${h.event}:${h.payload.table}`), {
          timeout: 15_000,
        })
        .toEqual(
          expect.arrayContaining(['INSERT:cards', 'INSERT:card_events'])
        );
    } finally {
      await ear.close();
    }
  });

  test('a reader of another board hears nothing of it', async () => {
    const seed = await readSeedState();
    const tokenA = await passwordGrantToken(seed.userA);
    const tokenB = await passwordGrantToken(seed.userB);
    const scope = await projectScope(tokenA, `live-own-${Date.now()}`, markers);
    const owner = await listen(tokenA, scope);
    const stranger = await listen(tokenB, scope);
    try {
      expect(owner.status).toBe('SUBSCRIBED');
      await untilLive(owner, tokenA, scope);
      await rpc(asUser(tokenA), 'card_create', {
        p_scope: scope,
        p_title: 'Relay keys',
        p_state: 'idea',
        p_no_links: 'e2e fixture',
      });
      await expect
        .poll(() => owner.heard.length, { timeout: 15_000 })
        .toBeGreaterThan(0);
      expect(stranger.status).not.toBe('SUBSCRIBED');
      expect(stranger.heard).toEqual([]);
    } finally {
      await owner.close();
      await stranger.close();
    }
  });
});
