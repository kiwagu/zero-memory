/**
 * Judge re-examination, LLM-free half: the candidate rollup
 * (`find_judge_rescan_candidates`) and the per-model guard that bounds it.
 *
 * The mechanism's whole claim is that a memory is eligible for ONE
 * re-examination per judge model: traffic decides WHICH memories are worth a
 * second opinion, a guard row decides that a model has already given one, and
 * a different model finds the population open again. Those three properties
 * are asserted here directly against the rollup, the way the detector calls
 * it — the judging itself is the ordinary pair scan and is covered elsewhere.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { expect, test } from '@playwright/test';

import { e2eEnv } from '../helpers/env.js';
import { firstJson, McpTestClient } from '../helpers/mcp.js';
import { readSeedState } from '../helpers/runtime-state.js';
import { passwordGrantToken } from '../helpers/users.js';

const MODEL_OLD = 'e2e-judge-generation-1';
const MODEL_NEW = 'e2e-judge-generation-2';

const adminClient = (): SupabaseClient =>
  createClient(e2eEnv.supabaseUrl, e2eEnv.supabaseServiceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

/** Domain usr_ id of a provisioned e2e user. */
const profileId = async (authUserId: string): Promise<string> => {
  const { data } = await adminClient()
    .from('profiles')
    .select('id')
    .eq('user_id', authUserId)
    .single();
  return data!.id as string;
};

/**
 * Record `count` recall surfacings of a memory, the way the tool ledger does.
 * Inserting straight into the table skips what the SERVER fills in on a real
 * call — the actor from the client handshake, the request id from the ambient
 * request context, the query — so they are set by hand: these rows also land
 * in the activity feed, where a row missing them reads as a product defect
 * rather than as a seeded one.
 */
const surface = async (
  ownerId: string,
  memoryId: string,
  count: number
): Promise<void> => {
  const rows = Array.from({ length: count }, (_unused, index) => ({
    event_type: 'mcp_tool_call',
    user_id: ownerId,
    quantity: 1,
    unit: 'count',
    agent_name: 'e2e-agent',
    request_id: `req_e2ejudgerescan${index % 10}.01e2ejudgescan`,
    metadata: {
      tool: 'recall',
      returned: 1,
      returned_ids: [memoryId],
      query: 'what did the judge rescan fixture record?',
    },
  }));
  const { error } = await adminClient().from('usage_events').insert(rows);
  expect(error).toBeNull();
};

/** Candidate ids for one model, as the detector reads them. */
const candidatesFor = async (
  model: string,
  ownerId?: string
): Promise<string[]> => {
  const { data, error } = await adminClient().rpc(
    'find_judge_rescan_candidates',
    {
      p_judge_model: model,
      p_window_days: 90,
      p_min_surfacings: 3,
      p_limit: 50,
      p_owner: ownerId ?? null,
    }
  );
  expect(error).toBeNull();
  return ((data ?? []) as Array<{ memory_id: string }>).map(
    (row) => row.memory_id
  );
};

/** Mark a memory as already examined by a model (what the detector stamps). */
const stamp = async (memoryId: string, model: string): Promise<void> => {
  const { error } = await adminClient()
    .from('memory_judge_checks')
    .upsert(
      { memory_id: memoryId, judge_model: model },
      { onConflict: 'memory_id,judge_model' }
    );
  expect(error).toBeNull();
};

test.describe('judge re-examination (traffic rollup + per-model guard)', () => {
  const seeded: string[] = [];

  // These markers would otherwise sit on page one of the owner's feed, where
  // other specs assert their own fixtures.
  test.afterAll(async () => {
    if (seeded.length > 0) {
      await adminClient().from('memories').delete().in('id', seeded);
    }
  });

  test('traffic selects, the guard silences, a new model re-opens', async () => {
    const seed = await readSeedState();
    const token = await passwordGrantToken(seed.userB);
    const ownerId = await profileId(seed.userB.id);
    const stampId = Date.now();

    const mcp = await McpTestClient.connect(token);
    let busy: string;
    let quiet: string;
    try {
      const write = async (content: string): Promise<string> => {
        const result = await mcp.callTool('remember', {
          content,
          kind: 'fact',
          scope: 'personal',
        });
        expect(result.isError ?? false).toBe(false);
        return firstJson<{ memory_id: string }>(result).memory_id;
      };
      busy = await write(
        `Judge rescan marker busy ${stampId}: the archive writer flushes ` +
          'its index before closing a segment.'
      );
      quiet = await write(
        `Judge rescan marker quiet ${stampId}: the archive reader memory-maps ` +
          'a segment before its first read.'
      );
    } finally {
      await mcp.close();
    }
    seeded.push(busy, quiet);

    // Traffic is the selector: one memory is served often, the other once.
    await surface(ownerId, busy, 4);
    await surface(ownerId, quiet, 1);

    const initial = await candidatesFor(MODEL_OLD, ownerId);
    expect(initial).toContain(busy);
    expect(initial).not.toContain(quiet);

    // Ordering is most-surfaced-first, so a capped run spends on the memories
    // the corpus actually serves.
    await surface(ownerId, quiet, 5);
    const ordered = await candidatesFor(MODEL_OLD, ownerId);
    expect(ordered.indexOf(quiet)).toBeLessThan(ordered.indexOf(busy));

    // The guard is per (memory, model): once this model has looked, it is
    // done — this is what makes a stable configuration cost nothing.
    await stamp(busy, MODEL_OLD);
    await stamp(quiet, MODEL_OLD);
    expect(await candidatesFor(MODEL_OLD, ownerId)).not.toContain(busy);

    // A different judge has not spoken about them yet, so it sees both again.
    const nextGeneration = await candidatesFor(MODEL_NEW, ownerId);
    expect(nextGeneration).toContain(busy);
    expect(nextGeneration).toContain(quiet);
  });

  test('an invalidated memory and another owner stay out of the population', async () => {
    const seed = await readSeedState();
    const ownerB = await profileId(seed.userB.id);
    const ownerA = await profileId(seed.userA.id);
    const stampId = Date.now();

    const mcp = await McpTestClient.connect(
      await passwordGrantToken(seed.userB)
    );
    let retired: string;
    try {
      const result = await mcp.callTool('remember', {
        content:
          `Judge rescan marker retired ${stampId}: the segment compactor ` +
          'rewrites indexes in place.',
        kind: 'fact',
        scope: 'personal',
      });
      expect(result.isError ?? false).toBe(false);
      retired = firstJson<{ memory_id: string }>(result).memory_id;
    } finally {
      await mcp.close();
    }
    seeded.push(retired);
    await surface(ownerB, retired, 4);

    // Owner scoping: the interactive path must not spend one person's
    // allowance re-examining another person's corpus.
    expect(await candidatesFor(MODEL_NEW, ownerA)).not.toContain(retired);

    // A retired memory is not worth a second opinion — recall cannot serve it.
    const { error } = await adminClient()
      .from('memories')
      .update({ invalidated_at: new Date().toISOString() })
      .eq('id', retired);
    expect(error).toBeNull();

    expect(await candidatesFor(MODEL_NEW, ownerB)).not.toContain(retired);
  });
});
