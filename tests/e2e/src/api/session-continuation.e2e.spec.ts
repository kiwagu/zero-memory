/**
 * A second conversation — another device, another client — is offered the
 * card the first one worked on last, and the briefing event records which
 * card it offered.
 */
import { expect, test } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';

import { e2eEnv } from '../helpers/env.js';
import { firstJson, McpTestClient } from '../helpers/mcp.js';
import { readSeedState } from '../helpers/runtime-state.js';
import { passwordGrantToken } from '../helpers/users.js';

interface Pack {
  session?: { thread?: string };
  work?: {
    bound_card: unknown;
    continuation?: {
      card: { id: string; number: number } | null;
      last: Array<{ type: string; text: string | null }>;
      last_session: {
        number: number;
        type: string;
        to_state: string | null;
      } | null;
      thread: string | null;
    } | null;
  };
}

const admin = () =>
  createClient(e2eEnv.supabaseUrl, e2eEnv.supabaseServiceRoleKey, {
    auth: { persistSession: false },
  });

const markers: string[] = [];

test.afterAll(async () => {
  if (markers.length > 0) {
    await admin().from('memories').delete().in('id', markers);
  }
});

test('a second conversation is offered the card the first one worked on last', async () => {
  const seed = await readSeedState();
  const token = await passwordGrantToken(seed.userA);
  const stamp = Date.now();
  const hint = `/tmp/zm-e2e-continuation-${stamp}`;
  const first = await McpTestClient.connect(token);
  const second = await McpTestClient.connect(token);
  const brief = async (agent: McpTestClient): Promise<Pack> => {
    const result = await agent.callTool('build_context', {
      topic: 'relay rollout',
      briefing: true,
      max_tokens: 1200,
      project_hint: hint,
    });
    expect(result.isError ?? false).toBe(false);
    return firstJson<Pack>(result);
  };
  try {
    const a = (await brief(first)).session?.thread;
    expect(a).toMatch(/^thr_/u);
    const made = await first.callTool('remember', {
      content: `e2e continuation marker ${stamp}: the relay rotates keys weekly`,
      kind: 'fact',
      project_hint: hint,
      thread: a,
    });
    const { scope, memory_id } = firstJson<{
      scope: string;
      memory_id: string;
    }>(made);
    markers.push(memory_id);
    const card = async (args: Record<string, unknown>) => {
      const result = await first.callTool('card', { thread: a, ...args });
      expect(result.isError ?? false).toBe(false);
      return firstJson<{ card: { id: string; number: number } }>(result).card;
    };
    const x = await card({
      action: 'create',
      scope,
      title: 'Relay keys',
      state: 'active',
      no_branch: 'e2e fixture',
      no_links: 'e2e fixture',
    });
    const noted = await first.callTool('card_log', {
      action: 'note',
      card_id: x.id,
      text: 'keys first, then the rollout',
      thread: a,
    });
    expect(noted.isError ?? false).toBe(false);

    const b1 = await brief(second);
    const threadB = b1.session?.thread;
    expect(threadB).toMatch(/^thr_/u);
    expect(threadB).not.toBe(a);
    expect(b1.work?.bound_card).toBeNull();
    expect(b1.work?.continuation?.card?.number).toBe(x.number);
    expect(b1.work?.continuation?.last[0]?.text).toBe(
      'keys first, then the rollout'
    );
    expect(b1.work?.continuation?.thread).toBe(threadB);

    // The first conversation starts Y, then parks X: Y is offered, and the
    // last step names X.
    const y = await card({
      action: 'create',
      scope,
      title: 'Relay rollout',
      state: 'active',
      no_branch: 'e2e fixture',
      no_links: 'e2e fixture',
    });
    await card({
      action: 'move',
      card_id: x.id,
      to: 'waiting',
      reason: 'waits for the key ceremony',
    });
    const b2 = await brief(second);
    expect(b2.work?.continuation?.card?.number).toBe(y.number);
    expect(b2.work?.continuation?.last_session).toMatchObject({
      number: x.number,
      type: 'moved',
      to_state: 'waiting',
    });

    // The briefing event records the offered card.
    await expect
      .poll(
        async () => {
          const { data } = await admin()
            .from('usage_events')
            .select('id')
            .eq('event_type', 'session_briefing')
            .eq('metadata->>continuation_card', y.id);
          return (data ?? []).length;
        },
        { timeout: 10_000 }
      )
      .toBeGreaterThan(0);
  } finally {
    await first.close();
    await second.close();
  }
});
