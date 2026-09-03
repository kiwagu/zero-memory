/**
 * Same-session refinement collapse, end-to-end: memories carry the MCP
 * session id in provenance source; two authoritative writes of ONE session
 * at the dedup threshold collapse deterministically (old superseded by
 * new, review queue untouched); the same pair across TWO sessions does NOT
 * collapse; a bare-slug scope is rejected at write time with a hint.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { expect, test } from '@playwright/test';

import { e2eEnv } from '../helpers/env.js';
import { readSeedState } from '../helpers/runtime-state.js';
import { contentText, firstJson, McpTestClient } from '../helpers/mcp.js';
import { passwordGrantToken } from '../helpers/users.js';

const adminClient = (): SupabaseClient =>
  createClient(e2eEnv.supabaseUrl, e2eEnv.supabaseServiceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

interface MemoryRow {
  superseded_by: string | null;
  invalidated_at: string | null;
  source: Record<string, unknown> | null;
}

const memoryRow = async (memoryId: string): Promise<MemoryRow> => {
  const { data, error } = await adminClient()
    .from('memories')
    .select('superseded_by, invalidated_at, source')
    .eq('id', memoryId)
    .single();
  if (error) {
    throw new Error(`memory lookup ${memoryId} failed: ${error.message}`);
  }
  return data as MemoryRow;
};

const queueRowsFor = async (ids: string[]): Promise<number> => {
  const list = ids.map((id) => `"${id}"`).join(',');
  const { data, error } = await adminClient()
    .from('memory_review_queue')
    .select('id')
    .or(`memory_a.in.(${list}),memory_b.in.(${list})`);
  if (error) {
    throw new Error(`queue lookup failed: ${error.message}`);
  }
  return data?.length ?? 0;
};

test.describe('Same-session refinement collapse over MCP', () => {
  test('two writes of one session at the dedup threshold: stamped, collapsed, queue untouched', async () => {
    const seed = await readSeedState();
    const mcp = await McpTestClient.connect(
      await passwordGrantToken(seed.userB)
    );
    try {
      const draft = await mcp.callTool('remember', {
        content:
          'e2e session-collapse marker: the release window for the ingest ' +
          'service is Monday morning',
        kind: 'decision',
        scope: 'personal',
      });
      expect(draft.isError ?? false).toBe(false);
      const oldId = firstJson<{ memory_id: string }>(draft).memory_id;

      // The write carries the transport session stamp (`ses_`).
      const draftRow = await memoryRow(oldId);
      const stamped = draftRow.source?.['session'];
      expect(typeof stamped).toBe('string');
      expect(stamped as string).toMatch(/^ses_/);

      // Same session, a refinement of the same statement (near-duplicate,
      // not exact): collapses deterministically — no judge, no queue.
      const refined = await mcp.callTool('remember', {
        content:
          'e2e session-collapse marker: the release window for the ingest ' +
          'service is Monday morning, 10:00 UTC',
        kind: 'decision',
        scope: 'personal',
      });
      expect(refined.isError ?? false).toBe(false);
      const refinedOut = firstJson<{
        memory_id: string;
        deduplicated?: boolean;
        similar_existing?: { id: string }[];
      }>(refined);
      const newId = refinedOut.memory_id;
      expect(newId).not.toBe(oldId);
      // The draft is collapsed, not offered back as a supersede hint — and
      // neither is the row just written. Other neighbours may legitimately
      // appear: the aperture is a floor plus a rank cap, not a narrow band.
      const offered = (refinedOut.similar_existing ?? []).map((c) => c.id);
      expect(offered).not.toContain(oldId);
      expect(offered).not.toContain(newId);

      const oldRow = await memoryRow(oldId);
      expect(oldRow.superseded_by).toBe(newId);
      expect(oldRow.invalidated_at).not.toBeNull();
      const newRow = await memoryRow(newId);
      expect(newRow.invalidated_at).toBeNull();
      expect(newRow.source?.['session']).toBe(stamped);

      // Nothing about this pair reached the human review queue.
      expect(await queueRowsFor([oldId, newId])).toBe(0);

      // Recall serves only the refined version.
      const recalled = contentText(
        await mcp.callTool('recall', {
          query: 'when is the release window for the ingest service?',
          k: 10,
        })
      );
      expect(recalled).toContain(newId);
      expect(recalled).not.toContain(oldId);
    } finally {
      await mcp.close();
    }
  });

  test('the same refinement across TWO sessions does not collapse', async () => {
    const seed = await readSeedState();
    const token = await passwordGrantToken(seed.userB);
    const first = await McpTestClient.connect(token);
    let oldId: string;
    try {
      const draft = await first.callTool('remember', {
        content:
          'e2e two-session marker: the retention policy for audit logs is ' +
          'ninety days',
        kind: 'decision',
        scope: 'personal',
      });
      expect(draft.isError ?? false).toBe(false);
      oldId = firstJson<{ memory_id: string }>(draft).memory_id;
    } finally {
      await first.close();
    }

    const second = await McpTestClient.connect(token);
    try {
      const refined = await second.callTool('remember', {
        content:
          'e2e two-session marker: the retention policy for audit logs is ' +
          'ninety days, enforced by a scheduled purge',
        kind: 'decision',
        scope: 'personal',
      });
      expect(refined.isError ?? false).toBe(false);
      const refinedOut = firstJson<{
        memory_id: string;
        similar_existing?: { id: string }[];
      }>(refined);
      const newId = refinedOut.memory_id;
      expect(newId).not.toBe(oldId);

      // The predecessor is OFFERED to the writing agent. This pair sits above
      // the same-scope dedup threshold, and dedup only swallows identical text
      // or a less authoritative write — so before the aperture was widened
      // this class was seen by neither mechanism and the agent got nothing.
      expect((refinedOut.similar_existing ?? []).map((c) => c.id)).toContain(
        oldId
      );

      // Different sessions: the deterministic rule must NOT fire — the old
      // version stays live and the pair goes through the standard cascade
      // (judge/queue), which never auto-retires a protected decision.
      const oldRow = await memoryRow(oldId);
      expect(oldRow.superseded_by).toBeNull();
      expect(oldRow.invalidated_at).toBeNull();
      const newRow = await memoryRow(newId);
      expect(newRow.invalidated_at).toBeNull();
      // Both carry stamps — provably different sessions.
      expect(oldRow.source?.['session']).toMatch(/^ses_/);
      expect(newRow.source?.['session']).toMatch(/^ses_/);
      expect(newRow.source?.['session']).not.toBe(oldRow.source?.['session']);
    } finally {
      await second.close();
    }
  });

  test('a bare-slug scope is rejected at write time with a hint', async () => {
    const seed = await readSeedState();
    const mcp = await McpTestClient.connect(
      await passwordGrantToken(seed.userB)
    );
    try {
      const write = await mcp.callTool('remember', {
        content: 'e2e bare-scope marker: this write must not land anywhere',
        kind: 'fact',
        scope: 'ulearn',
      });
      expect(write.isError ?? false).toBe(true);
      expect(contentText(write)).toContain('rooted ltree path');
    } finally {
      await mcp.close();
    }
  });
});
