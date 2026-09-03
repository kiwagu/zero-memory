/**
 * Usefulness-judge channel (recall-usefulness B-channel): an ingested chunk
 * that carries `recalled_ids` must produce `recall_used` events with
 * source='judge'.
 *
 * This channel was silently dead in production for weeks — the transcript
 * parser matched bare tool names while clients record MCP tools under a
 * namespaced name, so `recalled_ids` was always empty and the judge never
 * ran. Nothing failed; the events simply never appeared. This spec asserts
 * the emit path end-to-end so the channel cannot go quiet unnoticed again.
 * The e2e server runs the keyless deterministic judge (ZM_EXTRACTOR=
 * deterministic): a fact counts as used when a distinctive word of its
 * content appears in the transcript.
 */
import { expect, test } from '@playwright/test';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import { e2eEnv } from '../helpers/env.js';
import { firstJson, McpTestClient } from '../helpers/mcp.js';
import { passwordGrantToken, provisionE2EUser } from '../helpers/users.js';

interface RememberOutput {
  memory_id: string;
}

const DISTINCTIVE = 'quasarflux';

const adminClient = (): SupabaseClient =>
  createClient(e2eEnv.supabaseUrl, e2eEnv.supabaseServiceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

/** The judge is fire-and-forget after ingest; poll for its events. */
const awaitJudgeEvents = async (
  client: SupabaseClient,
  memoryId: string,
  timeoutMs = 15_000
): Promise<Array<Record<string, unknown>>> => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { data } = await client
      .from('usage_events')
      .select('metadata')
      .eq('event_type', 'recall_used')
      .eq('metadata->>mem_id', memoryId);
    const rows = (data ?? []) as Array<{ metadata: Record<string, unknown> }>;
    const judged = rows
      .map((row) => row.metadata)
      .filter((metadata) => metadata['source'] === 'judge');
    if (judged.length > 0 || Date.now() > deadline) {
      return judged;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
};

test.describe('usefulness judge channel', () => {
  test('an ingested chunk carrying recalled_ids emits judge-sourced recall_used', async () => {
    // A dedicated user: this asserts over ALL recall_used rows for one
    // memory, so a shared seed user's concurrent traffic must not leak in.
    const user = await provisionE2EUser('judge-channel@zm.e2e');
    const token = await passwordGrantToken(user);
    const admin = adminClient();
    const mcp = await McpTestClient.connect(token);
    try {
      const remembered = await mcp.callTool('remember', {
        content:
          `The ${DISTINCTIVE} scheduler retries twice before it gives up — ` +
          'a deliberate limit, not a default.',
        kind: 'gotcha',
        scope: 'personal',
      });
      expect(remembered.isError ?? false).toBe(false);
      const { memory_id: memoryId } = firstJson<RememberOutput>(remembered);

      // The transcript repeats the memory's distinctive word, so the
      // deterministic judge scores it as used.
      const ingested = await mcp.callTool('ingest_conversation', {
        transcript_chunk: [
          'user: why does the job stop after two attempts?',
          `assistant: that is the ${DISTINCTIVE} retry limit we recorded — ` +
            'deliberate, so I kept it.',
        ].join('\n'),
        chunk_hash: `e2e-judge-channel-${memoryId}`,
        client: 'zm-e2e',
        conversation_id: `judge-channel:${memoryId}`,
        recalled_ids: [memoryId],
      });
      expect(ingested.isError ?? false).toBe(false);

      const judged = await awaitJudgeEvents(admin, memoryId);
      expect(judged.length).toBeGreaterThan(0);
      expect(judged[0]).toMatchObject({ source: 'judge', useful: true });
      // conversation_id on judge events is what session-scoped consumers
      // (the rules incubator's "re-asked in N sessions") depend on.
      expect(judged[0]!['conversation_id']).toBe(`judge-channel:${memoryId}`);
    } finally {
      await mcp.close();
    }
  });
});
