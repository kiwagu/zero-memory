/**
 * Two long records that share an opening are not one record.
 *
 * The write-time duplicate probe compares `memories.embedding`, which the
 * model truncates at its input window. So two records identical for their
 * first ~2300 characters look identical to it however they end — and written
 * in one session they are taken for a refinement, which supersedes the older
 * one and takes its ending with it. That is the shape of a re-cut handover
 * note, so it is not hypothetical.
 *
 * The probe now also compares the overflow windows, and uses them ONLY to
 * refuse: a record is a duplicate when it is a duplicate all the way through.
 */
import { createClient } from '@supabase/supabase-js';
import { expect, test } from '@playwright/test';

import { e2eEnv } from '../helpers/env.js';
import { firstJson, McpTestClient } from '../helpers/mcp.js';
import { passwordGrantToken, provisionE2EUser } from '../helpers/users.js';

/** Long enough that the primary vector sees nothing but this. */
const SHARED_OPENING = (
  'The quarterly operations review records the arrangements the team keeps ' +
  'returning to: who owns the release calendar, how holiday cover is agreed, ' +
  'where the signed supplier contracts are filed, and which consumables are ' +
  'reordered on sight rather than on request. '
).repeat(6);

const ENDING_LEDGER =
  'What remains outstanding, and it is written here at the end: the supplier ' +
  'ledger has not been reconciled since the spring audit, two invoices are ' +
  'still disputed with the packaging vendor, and the finance team wants the ' +
  'reconciliation finished before the next quarterly close. Nobody has agreed ' +
  'who does it. The disputed invoices are filed in the grey cabinet with the ' +
  'audit correspondence, and the vendor has been told to expect a decision. '.repeat(
    2
  );

const ENDING_GREENHOUSE =
  'What remains outstanding, and it is written here at the end: the glasshouse ' +
  'irrigation controller keeps losing its schedule after a power cut, the ' +
  'seedling benches flooded twice last month, and the gardener wants a battery ' +
  'backup fitted before the growing season. Nobody has agreed who fits it. The ' +
  'controller manual is in the potting shed with the spare emitters, and the ' +
  'supplier has been asked to quote for the battery unit. '.repeat(2);

interface Stored {
  id: string;
  invalidated_at: string | null;
  superseded_by: string | null;
}

const adminClient = () =>
  createClient(e2eEnv.supabaseUrl, e2eEnv.supabaseServiceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

const readStored = async (id: string): Promise<Stored> => {
  const { data, error } = await adminClient()
    .from('memories')
    .select('id, invalidated_at, superseded_by')
    .eq('id', id)
    .single();
  if (error) {
    throw new Error(`read ${id} failed: ${error.message}`);
  }
  return data as Stored;
};

test.describe('write-time dedup', () => {
  test('records that share an opening but differ at the end both survive', async () => {
    const user = await provisionE2EUser(`zm-dedup-${Date.now()}@zm.e2e`);
    const mcp = await McpTestClient.connect(await passwordGrantToken(user));
    try {
      const remember = async (
        content: string
      ): Promise<{ memory_id: string; deduplicated?: boolean }> => {
        const result = await mcp.callTool('remember', {
          content,
          kind: 'fact',
          scope: 'personal',
        });
        expect(result.isError ?? false).toBe(false);
        return firstJson<{ memory_id: string; deduplicated?: boolean }>(result);
      };

      // Same session, same scope — the conditions a refinement is judged under.
      const first = await remember(`${SHARED_OPENING}${ENDING_LEDGER}`);
      const second = await remember(`${SHARED_OPENING}${ENDING_GREENHOUSE}`);

      expect(second.memory_id).not.toBe(first.memory_id);
      expect(second.deduplicated ?? false).toBe(false);

      // The older record keeps its ending: not invalidated, not superseded.
      const older = await readStored(first.memory_id);
      expect(
        older.invalidated_at,
        'the first record must survive: its ending is knowledge the second ' +
          'one does not contain'
      ).toBeNull();
      expect(older.superseded_by).toBeNull();

      // THE BAR IS A KNOB, not a constant — and an untested knob is a claim
      // rather than a feature. Disarmed, the probe matches the very pair it
      // just refused, which is the previous behaviour exactly.
      const { data: stored, error } = await adminClient()
        .from('memories')
        .select('embedding, scope')
        .eq('id', first.memory_id)
        .single();
      if (error) {
        throw new Error(`read vector of ${first.memory_id}: ${error.message}`);
      }
      const probe = stored as { embedding: string; scope: string };
      const disarmed = await adminClient().rpc('find_similar_memory', {
        query_embedding: probe.embedding,
        scope_filter: probe.scope,
        window_agreement: 0,
      });
      expect(disarmed.error).toBeNull();
      expect(
        (disarmed.data ?? []).length,
        'with the guard disarmed the probe behaves as it did before'
      ).toBeGreaterThan(0);
    } finally {
      await mcp.close();
    }
  });

  test('an identical record is still deduplicated', async () => {
    const user = await provisionE2EUser(`zm-dedup-same-${Date.now()}@zm.e2e`);
    const mcp = await McpTestClient.connect(await passwordGrantToken(user));
    try {
      const content = `${SHARED_OPENING}${ENDING_LEDGER}`;
      const write = async () => {
        const result = await mcp.callTool('remember', {
          content,
          kind: 'fact',
          scope: 'personal',
        });
        expect(result.isError ?? false).toBe(false);
        return firstJson<{ memory_id: string; deduplicated?: boolean }>(result);
      };

      // The guard must not have cost the thing dedup exists for: byte-identical
      // content still collapses, windows and all.
      const first = await write();
      const again = await write();
      expect(again.memory_id).toBe(first.memory_id);
      expect(again.deduplicated).toBe(true);
    } finally {
      await mcp.close();
    }
  });
});
