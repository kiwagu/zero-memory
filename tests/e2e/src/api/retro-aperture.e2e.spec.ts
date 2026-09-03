/**
 * The retro pass over the memory backlog, end to end: the server opens the
 * write-time aperture over history WITHOUT running a judge, parks each near
 * neighbour it finds as an `unjudged` pair, and the session agent adjudicates
 * it through the ordinary triage tools. Nothing is retired by the pass itself.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { expect, test } from '@playwright/test';

import { e2eEnv } from '../helpers/env.js';
import { readSeedState } from '../helpers/runtime-state.js';
import { firstJson, McpTestClient } from '../helpers/mcp.js';
import { passwordGrantToken } from '../helpers/users.js';

const adminClient = (): SupabaseClient =>
  createClient(e2eEnv.supabaseUrl, e2eEnv.supabaseServiceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

const run = promisify(execFile);

/**
 * Drives the shipped operator command rather than the class behind it, so the
 * entry point an operator actually types is what this spec covers. `--offer`
 * needs no model credentials, which is the point of that mode.
 */
const retroPass = async (args: string[]): Promise<string> => {
  const { stdout } = await run('bun', ['src/hygiene-retro.ts', ...args], {
    cwd: new URL('../../../../apps/server', import.meta.url).pathname,
    env: {
      ...process.env,
      SUPABASE_URL: e2eEnv.supabaseUrl,
      SUPABASE_SERVICE_ROLE_KEY: e2eEnv.supabaseServiceRoleKey,
    },
  });
  return stdout;
};

interface QueueRow {
  id: string;
  verdict: string;
  confidence: number | null;
  rationale: string | null;
  winner: string | null;
  similarity: number | null;
}

/** Profile (owner) id of an e2e account — what the pass scopes on. */
const ownerIdOf = async (userId: string): Promise<string> => {
  const { data, error } = await adminClient()
    .from('profiles')
    .select('id')
    .eq('user_id', userId)
    .single();
  if (error || !data) {
    throw new Error(`profile lookup failed: ${error?.message}`);
  }
  return (data as { id: string }).id;
};

const pairRow = async (a: string, b: string): Promise<QueueRow | null> => {
  const [memoryA, memoryB] = [a, b].sort();
  const { data } = await adminClient()
    .from('memory_review_queue')
    .select('id, verdict, confidence, rationale, winner, similarity')
    .eq('memory_a', memoryA)
    .eq('memory_b', memoryB)
    .maybeSingle();
  return (data as QueueRow | null) ?? null;
};

test.describe('Retro aperture over the backlog', () => {
  test('surfaces a neighbour pair as unjudged, and the agent settles it', async () => {
    const seed = await readSeedState();
    const token = await passwordGrantToken(seed.userB);

    // Two writes about one subject, from DIFFERENT sessions so neither the
    // same-session collapse nor write-time dedup settles them. Between them
    // they are near neighbours — which is all the aperture keys on.
    const markBefore = new Date(Date.now() - 1000).toISOString();
    const first = await McpTestClient.connect(token);
    let olderId: string;
    try {
      const written = await first.callTool('remember', {
        content:
          'e2e retro-aperture marker: the nightly export writes to the ' +
          'archive bucket in eu-central-1',
        kind: 'fact',
        scope: 'personal',
      });
      expect(written.isError ?? false).toBe(false);
      olderId = firstJson<{ memory_id: string }>(written).memory_id;
    } finally {
      await first.close();
    }

    const second = await McpTestClient.connect(token);
    let newerId: string;
    try {
      const written = await second.callTool('remember', {
        content:
          'e2e retro-aperture marker: nightly exports are archived in the ' +
          'eu-central-1 bucket, with a seven-day lifecycle rule',
        kind: 'fact',
        scope: 'personal',
      });
      expect(written.isError ?? false).toBe(false);
      newerId = firstJson<{ memory_id: string }>(written).memory_id;
      expect(newerId).not.toBe(olderId);
    } finally {
      await second.close();
    }

    // The pass walks history oldest-first from the cursor; starting just
    // before these two writes keeps the batch to them. It is ALSO scoped to
    // this account with --owner: the sweep is system-wide by default, so an
    // unscoped run here would queue pairs for every other account on the
    // stack — including the one a sibling spec asserts has an empty queue.
    const report = await retroPass([
      '--offer',
      '--max',
      '10',
      '--after',
      markBefore,
      '--owner',
      await ownerIdOf(seed.userB.id),
    ]);
    expect(report).toContain('agent judges');
    // No model was asked anything: the pass judges nothing.
    expect(report).toMatch(/pairs judged\s*:\s*0/);
    // The cursor advances while rows remain; exhaustion is an EMPTY page, not
    // a short one — a short page is what a database row cap also looks like.
    expect(report).toMatch(/next cursor\s*:\s*\d{4}-/);

    // The pair is parked with NO opinion attached — null confidence and
    // rationale are the honest state, not missing data.
    const row = await pairRow(olderId, newerId);
    expect(row).not.toBeNull();
    expect(row?.verdict).toBe('unjudged');
    expect(row?.confidence).toBeNull();
    expect(row?.rationale).toBeNull();
    expect(row?.winner).toBeNull();
    expect(row?.similarity ?? 0).toBeGreaterThan(0.8);

    // Neither memory was touched: the pass writes queue rows, nothing else.
    const { data: live } = await adminClient()
      .from('memories')
      .select('id, invalidated_at, superseded_by')
      .in('id', [olderId, newerId]);
    for (const memory of (live ?? []) as Array<{
      invalidated_at: string | null;
      superseded_by: string | null;
    }>) {
      expect(memory.invalidated_at).toBeNull();
      expect(memory.superseded_by).toBeNull();
    }

    // The agent reads it through the ordinary triage loop and settles it.
    const agent = await McpTestClient.connect(token);
    try {
      const listed = await agent.callTool('list_conflicts', {
        status: 'pending',
        verdict: 'unjudged',
        limit: 100,
      });
      expect(listed.isError ?? false).toBe(false);
      const conflicts = firstJson<{
        conflicts: Array<{ dispute_id: string; verdict: string }>;
      }>(listed).conflicts;
      expect(conflicts.map((c) => c.dispute_id)).toContain(row?.id);

      const resolved = await agent.callTool('resolve_conflict', {
        dispute_id: row?.id,
        keep_both: true,
      });
      expect(resolved.isError ?? false).toBe(false);
    } finally {
      await agent.close();
    }

    const settled = await pairRow(olderId, newerId);
    expect(settled).not.toBeNull();
    const { data: after } = await adminClient()
      .from('memory_review_queue')
      .select('status, resolution')
      .eq('id', row?.id ?? '')
      .single();
    expect((after as { status: string }).status).toBe('dismissed');
  });
});
