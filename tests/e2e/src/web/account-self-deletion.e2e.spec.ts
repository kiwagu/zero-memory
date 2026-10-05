/**
 * Account self-deletion: only a person, in the dashboard, can do it.
 *
 * The direct-RPC completeness of the cascade is pinned by account-lifecycle.e2e;
 * what THIS spec guards is who can reach it.
 *   1. An agent cannot: the memory server lists no deletion tool, and a call
 *      by the old name is refused.
 *   2. The person can, from Settings: confirming with their address erases
 *      everything the ownership map attributes to them and removes their auth
 *      principal, while user B — a bystander — is completely untouched. The
 *      route takes no subject, so (2) is also the proof that the subject is
 *      the signed-in caller, not anything a client could send.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { expect, test } from '@playwright/test';

import { userDataTables, ACCOUNT_OWNERSHIP_MAP } from '@workspace/db';

import { e2eEnv } from '../helpers/env.js';
import { firstJson, McpTestClient } from '../helpers/mcp.js';
import { enrollTotp, totpCode } from '../helpers/mfa.js';
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

test.describe('account self-deletion', () => {
  test('@smoke an agent has no way to delete the account', async () => {
    const db = admin();
    const agentUser = await freshUser(db, 'account-self-del-agent@zm.e2e');
    const token = await passwordGrantToken(agentUser.user);
    const mcp = await McpTestClient.connect(token);
    try {
      expect(await mcp.listToolNames()).not.toContain('delete_account');
      // Called by its old name anyway: refused, as an error or a thrown one.
      const outcome = await mcp
        .callTool('delete_account', {})
        .then((result) => (result.isError ? 'refused' : 'ran'))
        .catch(() => 'refused');
      expect(outcome).toBe('refused');
    } finally {
      await mcp.close();
    }
    const { data: still } = await db.auth.admin.getUserById(agentUser.user.id);
    expect(still.user?.id).toBe(agentUser.user.id);
    await db.rpc('hard_delete_user', { p_user_id: agentUser.userId });
  });

  test('@smoke the person deletes it in Settings; a bystander is untouched', async ({
    page,
  }) => {
    // The code step may wait for the authenticator's next 30-second window.
    test.setTimeout(120_000);
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

    // A erases itself in the dashboard — the request carries no subject. The
    // deletion is confirmed with a second factor, so A has one and gives it.
    const factor = await enrollTotp(aToken);
    await page.goto('/login');
    await page.getByTestId('auth-login-email').fill(a.user.email);
    await page.getByTestId('auth-login-password').fill(a.user.password);
    await page.getByTestId('auth-login-submit').click();
    await expect(page).toHaveURL(/\/mfa\/verify$/);
    await page
      .getByTestId('mfa-verify-code')
      .fill(await totpCode(factor.secret, factor.lastCode));
    await expect(page.getByTestId('insights-page')).toBeVisible();
    await page.goto('/settings');
    const erased = page.waitForResponse(
      (response) =>
        response.url().endsWith('/settings/delete-account') &&
        response.request().method() === 'POST'
    );
    await page.getByTestId('settings-delete-account-open').click();
    await page.getByTestId('settings-delete-account-input').fill(a.user.email);
    await page.getByTestId('settings-delete-account-confirm').click();
    // The page signs out and leaves right after the answer, which discards
    // its body; what the erasure did is read back from the database below.
    expect((await erased).status()).toBe(200);
    await expect(page).toHaveURL(/\/login/);

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
