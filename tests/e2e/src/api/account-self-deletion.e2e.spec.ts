/**
 * Account self-deletion through the `delete_account` MCP tool.
 *
 * The direct-RPC completeness of the cascade is pinned by account-lifecycle.e2e;
 * what THIS spec guards is the self-serve tool path the dashboard uses, and its
 * one load-bearing property: the tool takes NO subject, so it can only erase the
 * authenticated caller. Two guarantees:
 *   1. calling `delete_account` (no args) as user A erases everything the
 *      ownership map attributes to A, and removes A's auth principal;
 *   2. user B — a bystander who never called it — is completely untouched.
 * (2) is the proof that the subject comes from the caller's context, not from
 * anything a client could send.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { expect, test } from '@playwright/test';

import { userDataTables, ACCOUNT_OWNERSHIP_MAP } from '@workspace/db';

import { e2eEnv } from '../helpers/env.js';
import { firstJson, McpTestClient } from '../helpers/mcp.js';
import {
  passwordGrantToken,
  provisionE2EUser,
  type E2EUser,
} from '../helpers/users.js';

const admin = (): SupabaseClient =>
  createClient(e2eEnv.supabaseUrl, e2eEnv.supabaseServiceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

/** Provision fresh, erasing any leftover account from a prior failed run first. */
const freshUser = async (
  db: SupabaseClient,
  email: string
): Promise<{ user: E2EUser; userId: string }> => {
  const stale = await provisionE2EUser(email);
  const { data: staleProfile } = await db
    .from('profiles')
    .select('id')
    .eq('user_id', stale.id)
    .maybeSingle();
  if (staleProfile?.id) {
    await db.rpc('hard_delete_user', { p_user_id: staleProfile.id });
  }
  const user = await provisionE2EUser(email);
  const { data: profile } = await db
    .from('profiles')
    .select('id')
    .eq('user_id', user.id)
    .single();
  return { user, userId: profile!.id as string };
};

/** Remember one fact through the real tool and return its id. */
const rememberOne = async (token: string, content: string): Promise<string> => {
  const mcp = await McpTestClient.connect(token);
  try {
    const result = await mcp.callTool('remember', {
      content,
      kind: 'fact',
      scope: 'personal',
    });
    expect(result.isError ?? false).toBe(false);
    return firstJson<{ memory_id: string }>(result).memory_id;
  } finally {
    await mcp.close();
  }
};

const memoryCount = async (
  db: SupabaseClient,
  userId: string
): Promise<number> => {
  const { count } = await db
    .from('memories')
    .select('*', { count: 'exact', head: true })
    .eq('owner_id', userId);
  return count ?? 0;
};

test.describe('account self-deletion: delete_account tool', () => {
  test('erases the caller and leaves a bystander untouched', async () => {
    const db = admin();
    const a = await freshUser(db, 'account-self-del-a@zm.e2e');
    const b = await freshUser(db, 'account-self-del-b@zm.e2e');

    // Both users author memories through the real write path.
    const aToken = await passwordGrantToken(a.user);
    const bToken = await passwordGrantToken(b.user);
    const aMem = [
      await rememberOne(aToken, 'e2e self-delete: caller memory one.'),
      await rememberOne(aToken, 'e2e self-delete: caller memory two.'),
    ];
    await rememberOne(
      bToken,
      'e2e self-delete: bystander memory, must survive.'
    );
    expect(aMem.every(Boolean)).toBe(true);
    expect(await memoryCount(db, a.userId)).toBeGreaterThanOrEqual(2);
    expect(await memoryCount(db, b.userId)).toBeGreaterThanOrEqual(1);

    // Regression: a SHARED memory the caller owns must not block the erasure.
    // The cascade severs shared_by on surviving rows, but shared_by == owner_id
    // (owner-only sharing), so an unscoped sever would also null shared_by on
    // the caller's own still-shared rows and trip memories_shared_lifecycle_check
    // (visibility='shared' requires shared_at AND shared_by). Any account with a
    // shared memory could not be deleted until the sever was scoped to survivors.
    const { error: shareError } = await db
      .from('memories')
      .update({
        visibility: 'shared',
        shared_at: '2026-07-21T00:00:00Z',
        shared_by: a.userId,
      })
      .eq('id', aMem[0]!);
    expect(shareError, 'seed a shared memory for A').toBeNull();

    // A erases itself through the tool — no subject is sent.
    const mcp = await McpTestClient.connect(aToken);
    let summary: { auth_deleted: boolean; memories: number; subject: string };
    try {
      const result = await mcp.callTool('delete_account', {});
      expect(result.isError ?? false).toBe(false);
      summary = firstJson<typeof summary>(result);
    } finally {
      await mcp.close();
    }
    expect(summary.subject).toBe(a.userId);
    expect(summary.auth_deleted).toBe(true);
    expect(summary.memories).toBeGreaterThanOrEqual(2);

    // Completeness for A: every mapped user-data table holds zero rows keyed on
    // A's owner column (the transitive/anonymize dispositions are covered by the
    // direct-RPC spec; here the owned columns are the meaningful check).
    for (const table of userDataTables()) {
      const disposition = ACCOUNT_OWNERSHIP_MAP[table];
      if (disposition.kind !== 'owned') {
        continue;
      }
      const { count } = await db
        .from(table)
        .select('*', { count: 'exact', head: true })
        .eq(disposition.ownerColumn, a.userId);
      expect(count ?? 0, `expected zero A rows left in ${table}`).toBe(0);
    }

    // A's auth principal is gone.
    const { data: goneA } = await db.auth.admin.getUserById(a.user.id);
    expect(goneA.user).toBeNull();

    // The bystander is fully intact: memories survive and the account remains.
    expect(await memoryCount(db, b.userId)).toBeGreaterThanOrEqual(1);
    const { data: liveB } = await db.auth.admin.getUserById(b.user.id);
    expect(liveB.user?.id).toBe(b.user.id);

    // Cleanup: erase the bystander now that the isolation assertion has passed.
    await db.rpc('hard_delete_user', { p_user_id: b.userId });
  });
});
