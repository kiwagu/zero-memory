/**
 * The thread a client WITHOUT the briefing hook gets.
 *
 * Most clients have no hook, and until now they had no thread at all: their
 * reads could not survive a transport reconnect, and everything they stored
 * recorded no birth conversation — which left the whole session marker resting
 * on an optional local install. The server now falls back to the transport
 * session it always has, and a write picks that thread up without the agent
 * echoing anything.
 *
 * These specs speak the bare-client dialect on purpose: no `conversation_id`
 * anywhere, because that parameter is exactly what a hook-less client lacks.
 */
import { expect, test } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';

import { e2eEnv } from '../helpers/env.js';
import { firstJson, McpTestClient } from '../helpers/mcp.js';
import { passwordGrantToken, provisionE2EUser } from '../helpers/users.js';

interface Pack {
  session?: { attached_project: string | null; thread?: string };
}

/** The marker lives in provenance, which no read tool exposes — go to the row. */
const sourceOf = async (memoryId: string): Promise<Record<string, unknown>> => {
  const admin = createClient(
    e2eEnv.supabaseUrl,
    e2eEnv.supabaseServiceRoleKey,
    {
      auth: { persistSession: false, autoRefreshToken: false },
    }
  );
  const { data, error } = await admin
    .from('memories')
    .select('source')
    .eq('id', memoryId)
    .single();
  if (error) throw new Error(error.message);
  return (data as { source: Record<string, unknown> }).source ?? {};
};

test.describe('Hook-free thread over MCP', () => {
  test('a briefing with no conversation id still returns a thread', async () => {
    const user = await provisionE2EUser('hook-free-thread@zm.e2e');
    const mcp = await McpTestClient.connect(await passwordGrantToken(user));
    try {
      const pack = firstJson<Pack>(
        await mcp.callTool('build_context', {
          topic: 'tidal gauge calibration schedule',
          briefing: true,
          // A project hint but NO conversation id — the bare-client shape. The
          // project is required by design: a thread states where the work is,
          // and the server refuses to guess that.
          project_hint: '/home/someone/repos/tidal-gauge-e2e',
        })
      );

      expect(
        pack.session?.thread,
        'a bare client must get a token'
      ).toBeTruthy();
      expect(pack.session?.thread).toMatch(/^thr_/u);
    } finally {
      await mcp.close();
    }
  });

  test('a write with no echoed token is still attributed to the conversation', async () => {
    const user = await provisionE2EUser('hook-free-write@zm.e2e');
    const mcp = await McpTestClient.connect(await passwordGrantToken(user));
    try {
      // Read first — the discipline the product asks for anyway, and what
      // opens the thread this write will be stamped with.
      const pack = firstJson<Pack>(
        await mcp.callTool('build_context', {
          topic: 'tidal gauge calibration schedule',
          briefing: true,
          project_hint: '/home/someone/repos/tidal-gauge-e2e',
        })
      );
      const thread = pack.session?.thread;
      expect(thread).toBeTruthy();

      // Deliberately NO `thread` parameter: this is the case that used to
      // store a memory with no birth conversation at all.
      const stored = await mcp.callTool('remember', {
        content:
          'the tidal gauge is calibrated against the harbour datum every ' +
          'spring tide, and the reading is logged before the crew changes',
        kind: 'convention',
        scope: 'personal',
      });
      expect(stored.isError ?? false).toBe(false);
      const { memory_id } = firstJson<{ memory_id: string }>(stored);

      // THE CLAIM THIS SPEC EXISTS FOR: the stored row carries the marker,
      // pointing at the very thread the briefing returned — with the agent
      // having passed nothing.
      const source = await sourceOf(memory_id);
      expect(source['thread']).toBe(thread);
      expect(String(source['client_session_id'] ?? '')).toMatch(
        /^transport:ses_/u
      );
    } finally {
      await mcp.close();
    }
  });

  test('an echoed token keeps its own conversation across a reconnect', async () => {
    const user = await provisionE2EUser('hook-free-echo@zm.e2e');
    const token = await passwordGrantToken(user);

    const first = await McpTestClient.connect(token);
    let thread: string | undefined;
    try {
      const pack = firstJson<Pack>(
        await first.callTool('build_context', {
          topic: 'berth allocation for the night shift',
          briefing: true,
          project_hint: '/home/someone/repos/berth-allocation-e2e',
        })
      );
      thread = pack.session?.thread;
      expect(thread).toBeTruthy();
    } finally {
      await first.close();
    }

    // A NEW transport session — what a reconnect is. Echoing the token must
    // keep the same conversation instead of minting a second one, which is
    // the whole reason the echo exists.
    const second = await McpTestClient.connect(token);
    try {
      const pack = firstJson<Pack>(
        await second.callTool('build_context', {
          topic: 'berth allocation for the night shift',
          briefing: true,
          project_hint: '/home/someone/repos/berth-allocation-e2e',
          thread,
        })
      );
      expect(pack.session?.thread).toBe(thread);
    } finally {
      await second.close();
    }
  });
});
