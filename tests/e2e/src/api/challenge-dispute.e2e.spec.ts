/**
 * Challenge flow (single-subject disputes): `challenge` raises a verdict
 * `challenged` review-queue row for ONE memory (idempotent while open),
 * the owner sees it via list_conflicts with memory_b null, and
 * resolve_conflict settles it — uphold (winner = the memory) keeps it
 * alive, `retire: true` reversibly invalidates it (restore_memory undoes).
 * The stale-suspect rollup turns repeated misled signals into a queued
 * suspicion with a pending-exclusion and a resolved-after re-queue guard.
 */
import { expect, test } from '@playwright/test';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import { e2eEnv } from '../helpers/env.js';
import { firstJson, McpTestClient } from '../helpers/mcp.js';
import { readSeedState } from '../helpers/runtime-state.js';
import { passwordGrantToken, type E2EUser } from '../helpers/users.js';

interface ChallengeResult {
  dispute_id: string;
  already_pending: boolean;
}

interface ConflictList {
  conflicts: Array<{
    dispute_id: string;
    verdict: string;
    memory_a: { id: string };
    memory_b: { id: string } | null;
  }>;
}

const adminClient = (): SupabaseClient =>
  createClient(e2eEnv.supabaseUrl, e2eEnv.supabaseServiceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

const ownerEntityId = async (
  client: SupabaseClient,
  user: E2EUser
): Promise<string> => {
  const { data: profile, error } = await client
    .from('profiles')
    .select('id')
    .eq('user_id', user.id)
    .single();
  if (error || !profile) {
    throw new Error(`profile lookup failed: ${error?.message}`);
  }
  return (profile as { id: string }).id;
};

/** Seed one live memory for the user, service-role, idempotently. */
const seedMemory = async (
  client: SupabaseClient,
  ownerId: string,
  content: string
): Promise<string> => {
  const scope = `user.${ownerId.replace('.', '_')}`;
  const { data: existing } = await client
    .from('memories')
    .select('id, invalidated_at')
    .eq('owner_id', ownerId)
    .eq('content', content)
    .maybeSingle();
  if (existing) {
    const row = existing as { id: string; invalidated_at: string | null };
    if (row.invalidated_at !== null) {
      // A previous retire run left it invalidated — revive for a clean start.
      await client
        .from('memories')
        .update({
          invalidated_at: null,
          superseded_by: null,
          invalidated_by: null,
          invalidated_by_agent: null,
          invalidated_by_model: null,
        })
        .eq('id', row.id);
    }
    return row.id;
  }
  const { data: inserted, error } = await client
    .from('memories')
    .insert({ content, kind: 'decision', scope, owner_id: ownerId })
    .select('id')
    .single();
  if (error) {
    throw new Error(`challenge seed: insert failed: ${error.message}`);
  }
  return (inserted as { id: string }).id;
};

test.describe('challenge over MCP', () => {
  test('challenge raises an idempotent single-subject dispute the owner can list and retire, reversibly', async () => {
    const seed = await readSeedState();
    const admin = adminClient();
    const ownerId = await ownerEntityId(admin, seed.userB);
    const memoryId = await seedMemory(
      admin,
      ownerId,
      'E2E challenge fixture: the payment webhook retries five times.'
    );
    const mcp = await McpTestClient.connect(
      await passwordGrantToken(seed.userB)
    );
    try {
      const raised = await mcp.callTool('challenge', {
        memory_id: memoryId,
        reason: 'Observed only three retries in the gateway logs.',
        evidence: 'gateway log excerpt from the e2e stand',
      });
      expect(raised.isError ?? false).toBe(false);
      const dispute = firstJson<ChallengeResult>(raised);
      expect(dispute.already_pending).toBe(false);

      // Idempotent while open: same dispute id, flagged as already pending.
      const repeat = await mcp.callTool('challenge', {
        memory_id: memoryId,
        reason: 'Still doubtful.',
      });
      const again = firstJson<ChallengeResult>(repeat);
      expect(again.dispute_id).toBe(dispute.dispute_id);
      expect(again.already_pending).toBe(true);

      // The owner reads it as a single-subject conflict (memory_b null).
      const listed = await mcp.callTool('list_conflicts', {
        verdict: 'challenged',
      });
      const { conflicts } = firstJson<ConflictList>(listed);
      const mine = conflicts.find(
        (conflict) => conflict.dispute_id === dispute.dispute_id
      );
      expect(mine).toBeDefined();
      expect(mine!.memory_a.id).toBe(memoryId);
      expect(mine!.memory_b).toBeNull();

      // Retire reversibly invalidates the subject.
      const retired = await mcp.callTool('resolve_conflict', {
        dispute_id: dispute.dispute_id,
        retire: true,
      });
      expect(retired.isError ?? false).toBe(false);
      const { data: afterRetire } = await admin
        .from('memories')
        .select('invalidated_at, superseded_by')
        .eq('id', memoryId)
        .single();
      expect(
        (afterRetire as { invalidated_at: string | null }).invalidated_at
      ).not.toBeNull();
      expect(
        (afterRetire as { superseded_by: string | null }).superseded_by
      ).toBeNull();

      // restore_memory undoes the retirement — same escape hatch as pairs.
      const restored = await mcp.callTool('restore_memory', {
        memory_id: memoryId,
      });
      expect(restored.isError ?? false).toBe(false);
      const { data: afterRestore } = await admin
        .from('memories')
        .select('invalidated_at')
        .eq('id', memoryId)
        .single();
      expect(
        (afterRestore as { invalidated_at: string | null }).invalidated_at
      ).toBeNull();
    } finally {
      await mcp.close();
    }
  });

  test('a secret pasted as challenge evidence is rejected and never echoed', async () => {
    const seed = await readSeedState();
    const admin = adminClient();
    const ownerId = await ownerEntityId(admin, seed.userB);
    const memoryId = await seedMemory(
      admin,
      ownerId,
      'E2E challenge fixture: the release script tags with the sprint name.'
    );
    const mcp = await McpTestClient.connect(
      await passwordGrantToken(seed.userB)
    );
    try {
      const token = `ghp_${'B'.repeat(36)}`;
      const rejected = await mcp.callTool('challenge', {
        memory_id: memoryId,
        reason: 'The tag format changed.',
        evidence: `ci run with ${token} shows semver tags`,
      });
      expect(rejected.isError ?? false).toBe(true);
      const text = JSON.stringify(rejected.content);
      expect(text).toContain('secret_content_rejected');
      expect(text).not.toContain(token);
    } finally {
      await mcp.close();
    }
  });

  test('upholding a challenged memory dismisses the dispute and keeps it live', async () => {
    const seed = await readSeedState();
    const admin = adminClient();
    const ownerId = await ownerEntityId(admin, seed.userB);
    const memoryId = await seedMemory(
      admin,
      ownerId,
      'E2E challenge fixture: the nightly export runs at 03:00 UTC.'
    );
    const mcp = await McpTestClient.connect(
      await passwordGrantToken(seed.userB)
    );
    try {
      const raised = await mcp.callTool('challenge', {
        memory_id: memoryId,
        reason: 'Suspected the schedule moved.',
      });
      const dispute = firstJson<ChallengeResult>(raised);

      const upheld = await mcp.callTool('resolve_conflict', {
        dispute_id: dispute.dispute_id,
        winner: memoryId,
      });
      expect(upheld.isError ?? false).toBe(false);

      const { data: row } = await admin
        .from('memory_review_queue')
        .select('status, resolution')
        .eq('id', dispute.dispute_id)
        .single();
      expect(row).toMatchObject({ status: 'dismissed', resolution: 'upheld' });

      const { data: memory } = await admin
        .from('memories')
        .select('invalidated_at')
        .eq('id', memoryId)
        .single();
      expect(
        (memory as { invalidated_at: string | null }).invalidated_at
      ).toBeNull();
    } finally {
      await mcp.close();
    }
  });
});

test.describe('stale-suspect rollup', () => {
  test('repeated misled signals cross the threshold once, honor the pending exclusion and the resolved-after guard', async () => {
    const seed = await readSeedState();
    const admin = adminClient();
    const ownerId = await ownerEntityId(admin, seed.userB);
    const memoryId = await seedMemory(
      admin,
      ownerId,
      'E2E stale-suspect fixture: the cache TTL is ninety seconds.'
    );
    // Clean slate for reruns: this fixture's events and queue rows only.
    await admin
      .from('memory_review_queue')
      .delete()
      .eq('memory_a', memoryId)
      .is('memory_b', null);
    await admin
      .from('usage_events')
      .delete()
      .eq('event_type', 'recall_used')
      .eq('metadata->>mem_id', memoryId);

    const misledEvent = (source: 'challenge' | 'judge') => ({
      user_id: ownerId,
      event_type: 'recall_used',
      metadata: {
        mem_id: memoryId,
        source,
        useful: false,
        valence: 'misled',
        ...(source === 'judge' && { confidence: 0.9 }),
      },
    });

    // One signal: below the threshold of two.
    await admin.from('usage_events').insert([misledEvent('challenge')]);
    const below = await admin.rpc('find_stale_suspects', {
      p_threshold: 2,
      p_window_days: 90,
    });
    expect(
      (below.data ?? []).some(
        (row: { memory_id: string }) => row.memory_id === memoryId
      )
    ).toBe(false);

    // Second signal (judge, confidence over the 0.6 floor): flagged.
    await admin.from('usage_events').insert([misledEvent('judge')]);
    const flagged = await admin.rpc('find_stale_suspects', {
      p_threshold: 2,
      p_window_days: 90,
    });
    const hit = (flagged.data ?? []).find(
      (row: { memory_id: string }) => row.memory_id === memoryId
    ) as { misled_count: number } | undefined;
    expect(hit).toBeDefined();
    expect(hit!.misled_count).toBe(2);

    // Queue the suspicion: the pending row excludes it from the next rollup.
    const { data: queued, error: queueError } = await admin
      .from('memory_review_queue')
      .insert({
        memory_a: memoryId,
        memory_b: null,
        verdict: 'stale_suspect',
        rationale: '2 misled signals (e2e).',
      })
      .select('id')
      .single();
    expect(queueError).toBeNull();
    const whilePending = await admin.rpc('find_stale_suspects', {
      p_threshold: 2,
      p_window_days: 90,
    });
    expect(
      (whilePending.data ?? []).some(
        (row: { memory_id: string }) => row.memory_id === memoryId
      )
    ).toBe(false);

    // Dismissing the suspicion arms the guard: the SAME evidence never
    // re-raises it. resolved_at anchors to the newest event's DB timestamp,
    // not this machine's clock — the guard compares strictly greater, so
    // existing evidence is excluded and later inserts (DB now()) count.
    const { data: newest } = await admin
      .from('usage_events')
      .select('occurred_at')
      .eq('event_type', 'recall_used')
      .eq('metadata->>mem_id', memoryId)
      .order('occurred_at', { ascending: false })
      .limit(1)
      .single();
    await admin
      .from('memory_review_queue')
      .update({
        status: 'dismissed',
        resolution: 'upheld',
        resolved_at: (newest as { occurred_at: string }).occurred_at,
      })
      .eq('id', (queued as { id: string }).id);
    const afterDismiss = await admin.rpc('find_stale_suspects', {
      p_threshold: 2,
      p_window_days: 90,
    });
    expect(
      (afterDismiss.data ?? []).some(
        (row: { memory_id: string }) => row.memory_id === memoryId
      )
    ).toBe(false);

    // ...but two NEW misled signals after the resolution do.
    await admin
      .from('usage_events')
      .insert([misledEvent('challenge'), misledEvent('judge')]);
    const reRaised = await admin.rpc('find_stale_suspects', {
      p_threshold: 2,
      p_window_days: 90,
    });
    expect(
      (reRaised.data ?? []).some(
        (row: { memory_id: string }) => row.memory_id === memoryId
      )
    ).toBe(true);
  });
});
