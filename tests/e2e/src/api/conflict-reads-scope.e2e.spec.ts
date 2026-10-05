/**
 * The review-queue tools answer about the caller's conflicts only, in every
 * number they report: a page limit counts the caller's conflicts, not the
 * whole instance's, and a bulk resolve neither sees nor counts anyone else's.
 * Restoring a memory removes the caller's own `supersedes` links to it and
 * leaves another member's statement about it alone.
 *
 * Fresh accounts per test: the seeded users carry other specs' leftovers, and
 * these assertions are about exact counts.
 */
import { expect, test } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';

import { e2eEnv } from '../helpers/env.js';
import { firstJson, McpTestClient } from '../helpers/mcp.js';
import {
  entityIdOf,
  passwordGrantToken,
  provisionE2EUser,
  type E2EUser,
} from '../helpers/users.js';

const admin = () =>
  createClient(e2eEnv.supabaseUrl, e2eEnv.supabaseServiceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

const freshUser = async (label: string) => {
  const user = await provisionE2EUser(
    `conflict-scope-${label}-${Date.now()}@zm.e2e`
  );
  return { user, ownerId: await entityIdOf(user.id) };
};

/** A personal memory written straight into the store, as a fixture. */
const insertMemory = async (ownerId: string, content: string) => {
  const { data, error } = await admin()
    .from('memories')
    .insert({
      content,
      kind: 'decision',
      scope: `user.${ownerId.replace('.', '_')}`,
      owner_id: ownerId,
    })
    .select('id')
    .single();
  if (error || !data) {
    throw new Error(`fixture memory failed: ${error?.message}`);
  }
  return (data as { id: string }).id;
};

/** One pending conflict between two fresh memories of the owner. */
const seedConflict = async (
  ownerId: string,
  label: string,
  createdAt: string
): Promise<string> => {
  const a = await insertMemory(ownerId, `${label}: deploys run on Fridays.`);
  const b = await insertMemory(
    ownerId,
    `${label}: deploys never run on Fridays.`
  );
  const [memoryA, memoryB] = [a, b].sort();
  const { data, error } = await admin()
    .from('memory_review_queue')
    .insert({
      memory_a: memoryA,
      memory_b: memoryB,
      verdict: 'contradiction',
      confidence: 0.9,
      rationale: 'E2E seeded contradiction.',
      status: 'pending',
      created_at: createdAt,
    })
    .select('id')
    .single();
  if (error || !data) {
    throw new Error(`fixture conflict failed: ${error?.message}`);
  }
  return (data as { id: string }).id;
};

const connect = async (user: E2EUser) =>
  McpTestClient.connect(await passwordGrantToken(user));

test.describe('the review queue answers about the caller only', () => {
  test('@smoke a page limit counts the caller’s conflicts, not the instance’s', async () => {
    const mine = await freshUser('list-mine');
    const theirs = await freshUser('list-theirs');
    const older = new Date(Date.now() - 60_000).toISOString();
    const own = await seedConflict(mine.ownerId, 'e2e list own', older);
    // Newer conflicts of somebody else sit ahead of it in the queue.
    for (let i = 0; i < 3; i += 1) {
      await seedConflict(
        theirs.ownerId,
        `e2e list other ${i}`,
        new Date().toISOString()
      );
    }

    const mcp = await connect(mine.user);
    try {
      const listed = await mcp.callTool('list_conflicts', { limit: 1 });
      expect(listed.isError ?? false).toBe(false);
      const conflicts = firstJson<{
        conflicts: Array<{ dispute_id: string }>;
      }>(listed).conflicts;
      expect(conflicts.map((conflict) => conflict.dispute_id)).toEqual([own]);
    } finally {
      await mcp.close();
    }
  });

  test('@smoke a bulk resolve neither touches nor counts another owner’s conflicts', async () => {
    const mine = await freshUser('bulk-mine');
    const theirs = await freshUser('bulk-theirs');
    await seedConflict(mine.ownerId, 'e2e bulk own', new Date().toISOString());
    const others = [];
    for (let i = 0; i < 3; i += 1) {
      others.push(
        await seedConflict(
          theirs.ownerId,
          `e2e bulk other ${i}`,
          new Date().toISOString()
        )
      );
    }

    const mcp = await connect(mine.user);
    try {
      const resolved = await mcp.callTool('resolve_conflicts', {
        policy: 'keep_both',
      });
      expect(resolved.isError ?? false).toBe(false);
      expect(
        firstJson<{ resolved: number; skipped: number }>(resolved)
      ).toEqual({ resolved: 1, skipped: 0 });
    } finally {
      await mcp.close();
    }
    const { data } = await admin()
      .from('memory_review_queue')
      .select('status')
      .in('id', others);
    expect((data ?? []).map((row) => row.status)).toEqual([
      'pending',
      'pending',
      'pending',
    ]);
  });

  test('@smoke restoring a memory keeps another member’s supersedes link to it', async () => {
    const mine = await freshUser('restore-mine');
    const theirs = await freshUser('restore-theirs');
    const target = await insertMemory(
      mine.ownerId,
      `e2e restore target ${Date.now()}: the cache lives for an hour.`
    );
    const myNewer = await insertMemory(
      mine.ownerId,
      `e2e restore mine ${Date.now()}: the cache lives for a day.`
    );
    const theirNewer = await insertMemory(
      theirs.ownerId,
      `e2e restore theirs ${Date.now()}: the cache lives for a week.`
    );
    const { error } = await admin()
      .from('memory_links')
      .insert([
        { src: myNewer, dst: target, type: 'supersedes' },
        { src: theirNewer, dst: target, type: 'supersedes' },
      ]);
    expect(error).toBeNull();

    const mcp = await connect(mine.user);
    try {
      const forgot = await mcp.callTool('forget', { memory_id: target });
      expect(forgot.isError ?? false).toBe(false);
      const restored = await mcp.callTool('restore_memory', {
        memory_id: target,
      });
      expect(restored.isError ?? false).toBe(false);
    } finally {
      await mcp.close();
    }

    const { data: links } = await admin()
      .from('memory_links')
      .select('src')
      .eq('dst', target)
      .eq('type', 'supersedes');
    expect((links ?? []).map((link) => link.src)).toEqual([theirNewer]);
  });
});
