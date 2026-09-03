/**
 * The session marker in memory provenance, end-to-end: a memory written
 * inside an attached conversation carries that conversation's identity —
 * the `thr_` thread token plus the client's own session id — and nothing of
 * what was said in it. The watcher's transcript ingest carries the same
 * marker. A write with no conversation behind it carries neither, which is an
 * honest state rather than a gap.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { expect, test } from '@playwright/test';

import { e2eEnv } from '../helpers/env.js';
import { firstJson, McpTestClient } from '../helpers/mcp.js';
import { readSeedState } from '../helpers/runtime-state.js';
import {
  passwordGrantToken,
  provisionE2EUser,
  userRestClient,
} from '../helpers/users.js';

interface Briefed {
  project_scope?: string;
  session?: { thread?: string };
}

interface Remembered {
  memory_id: string;
  scope?: string;
}

interface IngestOutput {
  duplicate: boolean;
  memories_created: number;
  memory_ids: string[];
}

/**
 * A watcher-shaped chunk in the deterministic extractor's grammar (the test
 * contour runs it keyless), so exactly one memory is created and the marker
 * assertions are not at the mercy of a model's judgement. TRANSCRIPT_ONLY sits
 * on a line the extractor ignores: it is the phrase that proves the server
 * kept a pointer to this conversation and none of its text.
 */
const TRANSCRIPT_ONLY = 'unremarkable-chatter-session-marker-e2e';
const TRANSCRIPT_CHUNK = [
  `user: ${TRANSCRIPT_ONLY} — anyway, one thing to write down before we lose it`,
  'assistant: GOTCHA: the marker stand bounces its gateway after a database',
  'reset, otherwise it keeps resolving the old upstream containers',
].join('\n');

/** The provenance `source` of a memory, read back through the owner's RLS. */
const sourceOf = async (
  token: string,
  memoryId: string
): Promise<Record<string, unknown>> => {
  const { data, error } = await userRestClient(token)
    .from('memories')
    .select('source')
    .eq('id', memoryId)
    .single();
  if (error) {
    throw new Error(`memory lookup ${memoryId} failed: ${error.message}`);
  }
  return ((data as { source: Record<string, unknown> | null }).source ??
    {}) as Record<string, unknown>;
};

const adminClient = (): SupabaseClient =>
  createClient(e2eEnv.supabaseUrl, e2eEnv.supabaseServiceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

/** Ids seeded here, removed in afterAll — see the note on the describe block. */
const seededMemories: string[] = [];

test.describe('The session marker in provenance', () => {
  // Two of these tests write into a SEED user's dataset, which lands in the
  // default dashboard feed that other specs assert on page one of. Delete what
  // this spec seeded, so a marker test never fails a feed test.
  test.afterAll(async () => {
    if (seededMemories.length > 0) {
      await adminClient().from('memories').delete().in('id', seededMemories);
    }
  });

  test('an in-band write carries the conversation it was born in', async () => {
    const seed = await readSeedState();
    const token = await passwordGrantToken(seed.userB);
    const conversationId = 'e2e-session-marker-conversation';

    // Connection 1 stands in for the briefing hook: it names the conversation,
    // and the server mints the thread that addresses it.
    let thread: string | undefined;
    const hook = await McpTestClient.connect(token);
    try {
      const briefed = firstJson<Briefed>(
        await hook.callTool('build_context', {
          topic: 'session marker stand',
          briefing: true,
          project_hint: '/home/someone/repos/marker-stand-e2e',
          conversation_id: conversationId,
        })
      );
      thread = briefed.session?.thread;
      expect(thread).toMatch(/^thr_/);
    } finally {
      await hook.close();
    }

    const agent = await McpTestClient.connect(token);
    try {
      const stored = firstJson<Remembered>(
        await agent.callTool('remember', {
          content:
            'e2e session-marker: the marker stand bounces its gateway after ' +
            'a database reset so upstreams are re-resolved',
          kind: 'fact',
          thread,
        })
      );

      seededMemories.push(stored.memory_id);

      const source = await sourceOf(token, stored.memory_id);
      // A POINTER to the conversation, in both id spaces: ours (survives a
      // reconnect) and the client's (finds the local transcript again).
      expect(source.thread).toBe(thread);
      expect(source.client_session_id).toBe(conversationId);
    } finally {
      await agent.close();
    }
  });

  test('a transcript ingest carries the same marker', async () => {
    // A dedicated user: extraction is a live LLM call writing unpredictable
    // content, which the shared seed users' invariants must not absorb.
    const user = await provisionE2EUser('session-marker-ingest@zm.e2e');
    const token = await passwordGrantToken(user);
    const conversationId = 'e2e-session-marker-ingest-conversation';

    const mcp = await McpTestClient.connect(token);
    try {
      // The hook side again: the watcher's conversation has a live thread by
      // the time its chunk arrives, exactly as in a real session.
      const briefed = firstJson<Briefed>(
        await mcp.callTool('build_context', {
          topic: 'marker stand gateway',
          briefing: true,
          project_hint: '/home/e2e/marker-ingest-repo',
          conversation_id: conversationId,
        })
      );
      const thread = briefed.session?.thread;
      expect(thread).toMatch(/^thr_/);

      const ingested = firstJson<IngestOutput>(
        await mcp.callTool('ingest_conversation', {
          transcript_chunk: TRANSCRIPT_CHUNK,
          chunk_hash: 'e2e-session-marker-0001',
          client: 'claude-code-stop-hook',
          conversation_id: conversationId,
          project_hint: '/home/e2e/marker-ingest-repo',
        })
      );
      expect(ingested.duplicate).toBe(false);

      // Whatever the extractor CREATED carries the marker. `memory_ids` may
      // also hold dedup hits — pre-existing memories the chunk collapsed into
      // — which keep their own provenance, so only watcher-stamped rows are
      // asserted (and cleaned up below).
      const { data: rows } = await userRestClient(token)
        .from('memories')
        .select('id, agent_name, source')
        .in('id', ingested.memory_ids);
      const watcherRows = (rows ?? []).filter(
        (row) => row.agent_name === 'watcher'
      );
      expect(watcherRows.length).toBeGreaterThan(0);
      for (const row of watcherRows) {
        const source = (row.source ?? {}) as Record<string, unknown>;
        expect(source.client_session_id).toBe(conversationId);
        expect(source.thread).toBe(thread);
        // The hard boundary: a pointer to the conversation, never a piece of
        // it. Nothing server-side holds the transcript text.
        expect(JSON.stringify(source)).not.toContain(TRANSCRIPT_ONLY);
      }

      // Cleanup: live-LLM extraction writes unpredictable content into the
      // dataset; forget what this run created.
      for (const row of watcherRows) {
        await mcp.callTool('forget', { memory_id: row.id });
      }
    } finally {
      await mcp.close();
    }
  });

  test('a write with no conversation behind it carries no marker', async () => {
    const seed = await readSeedState();
    const token = await passwordGrantToken(seed.userB);

    const mcp = await McpTestClient.connect(token);
    try {
      // Terminal quick-capture and friends: no conversation, so no marker.
      // Absence is the honest answer — a stamped-anyway pointer would address
      // a conversation that never existed.
      const stored = firstJson<Remembered>(
        await mcp.callTool('remember', {
          content:
            'e2e session-marker: captured outside any conversation, so it ' +
            'points at none',
          kind: 'fact',
          scope: 'personal',
        })
      );

      seededMemories.push(stored.memory_id);

      const source = await sourceOf(token, stored.memory_id);
      expect(source).not.toHaveProperty('thread');
      expect(source).not.toHaveProperty('client_session_id');
      // The routing audit is still there — this is a marker-shaped absence,
      // not an empty provenance.
      expect(source).toHaveProperty('routing');
    } finally {
      await mcp.close();
    }
  });
});
