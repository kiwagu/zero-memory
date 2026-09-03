/**
 * The session marker on the memory detail page: a fact born in a conversation
 * shows that conversation's pointer in its provenance panel, and lists the
 * other facts that came out of the same conversation — the readable half of
 * the marker, and the reason it is worth stamping.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { expect, test } from '@playwright/test';

import { e2eEnv } from '../helpers/env.js';
import { firstJson, McpTestClient } from '../helpers/mcp.js';
import { readSeedState } from '../helpers/runtime-state.js';
import { passwordGrantToken } from '../helpers/users.js';
import { signInThroughForm } from '../helpers/web.js';

interface Briefed {
  project_scope?: string;
  session?: { thread?: string };
}

const adminClient = (): SupabaseClient =>
  createClient(e2eEnv.supabaseUrl, e2eEnv.supabaseServiceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

/** Ids seeded here, removed in afterAll — see the note on the describe block. */
const seededMemories: string[] = [];

test.describe('the session marker on a memory page', () => {
  // These writes land in the DEFAULT feed view, and other specs assert the
  // seeded fixtures on page ONE of that same feed — leaving them behind would
  // push the fixtures off it and fail specs that have nothing to do with this
  // one. The house pattern: delete what the spec seeded.
  test.afterAll(async () => {
    if (seededMemories.length > 0) {
      await adminClient().from('memories').delete().in('id', seededMemories);
    }
  });

  test('shows the conversation pointer and its same-session siblings', async ({
    page,
  }) => {
    const seed = await readSeedState();
    const token = await passwordGrantToken(seed.userB);
    const conversationId = 'web-e2e-session-marker-conversation';

    // The briefing hook's side: name the conversation, get its thread.
    const hook = await McpTestClient.connect(token);
    let thread: string | undefined;
    try {
      const briefed = firstJson<Briefed>(
        await hook.callTool('build_context', {
          topic: 'numbat telemetry',
          briefing: true,
          project_hint: '/home/someone/repos/numbat-telemetry-e2e',
          conversation_id: conversationId,
        })
      );
      thread = briefed.session?.thread;
      expect(thread).toMatch(/^thr_/);
    } finally {
      await hook.close();
    }

    // Two facts out of ONE conversation: the page opened below is the first,
    // the second is what its "same session" section must find.
    const agent = await McpTestClient.connect(token);
    let firstId: string;
    try {
      const first = firstJson<{ memory_id: string }>(
        await agent.callTool('remember', {
          content:
            'web-e2e marker: numbat telemetry batches its spans every five ' +
            'seconds',
          kind: 'fact',
          thread,
        })
      );
      firstId = first.memory_id;
      seededMemories.push(firstId);
      const sibling = firstJson<{ memory_id: string }>(
        await agent.callTool('remember', {
          content:
            'web-e2e marker sibling: numbat telemetry drops a batch rather ' +
            'than blocking the caller when its queue is full',
          kind: 'decision',
          thread,
        })
      );
      seededMemories.push(sibling.memory_id);
    } finally {
      await agent.close();
    }

    await signInThroughForm(page, seed.userB);
    await page.goto(`/memory/${firstId}`);

    // The pointer itself, in the provenance panel — the thread token and the
    // client's own conversation id, and no transcript beside them.
    const provenance = page.getByTestId('memory-provenance');
    await expect(provenance).toContainText(thread!);
    await expect(provenance).toContainText(conversationId);

    // …and the neighbourhood it buys: the other fact from that conversation,
    // reachable as a link rather than only as a search.
    const sameSession = page.getByTestId('memory-same-session');
    await expect(sameSession).toBeVisible();
    await expect(sameSession).toContainText('drops a batch');
    await expect(
      sameSession.getByRole('link', { name: /drops a batch/i })
    ).toBeVisible();
  });

  test('a memory born outside any conversation shows no session section', async ({
    page,
  }) => {
    const seed = await readSeedState();
    const token = await passwordGrantToken(seed.userB);

    const mcp = await McpTestClient.connect(token);
    let memoryId: string;
    try {
      const stored = firstJson<{ memory_id: string }>(
        await mcp.callTool('remember', {
          content:
            'web-e2e marker: written with no conversation attached, so the ' +
            'page shows no session neighbourhood',
          kind: 'fact',
          scope: 'personal',
        })
      );
      memoryId = stored.memory_id;
      seededMemories.push(memoryId);
    } finally {
      await mcp.close();
    }

    await signInThroughForm(page, seed.userB);
    await page.goto(`/memory/${memoryId}`);

    // The section is absent rather than empty: there is no conversation to
    // report on, and an empty "from the same session" would imply there was.
    await expect(page.getByTestId('memory-detail-content')).toBeVisible();
    await expect(page.getByTestId('memory-same-session')).toHaveCount(0);
  });
});
