/**
 * RLS scope isolation seen from outside: user B must not see user A's
 * personal memory through ANY public surface — MCP recall, build_context,
 * or PostgREST directly. This is the data boundary the product promises.
 *
 * The last block covers the neighbouring boundary: WHO ELSE exists here. A
 * signed-in account must not be able to enumerate the instance's users, and
 * the one flow that legitimately turns an address into a user id must stay a
 * single-address answer for a scope administrator, never a listing.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { expect, test } from '@playwright/test';

import { e2eEnv } from '../helpers/env.js';
import { RLS_PRIVATE_MEMORY } from '../helpers/fixture-memories.js';
import { contentText, firstJson, McpTestClient } from '../helpers/mcp.js';
import { readSeedState } from '../helpers/runtime-state.js';
import {
  passwordGrantToken,
  provisionE2EUser,
  userRestClient,
  type E2EUser,
} from '../helpers/users.js';

test.describe('RLS scope isolation', () => {
  test('@smoke owner sees the private memory through MCP recall', async () => {
    const seed = await readSeedState();
    const mcp = await McpTestClient.connect(
      await passwordGrantToken(seed.userA)
    );
    try {
      const recalled = await mcp.callTool('recall', {
        query: 'which memory is visible only to e2e user A?',
        k: 10,
      });
      expect(recalled.isError ?? false).toBe(false);
      expect(contentText(recalled)).toContain(seed.rlsPrivateMemoryId);
    } finally {
      await mcp.close();
    }
  });

  test('@smoke another user cannot reach it through MCP recall or build_context', async () => {
    const seed = await readSeedState();
    const mcp = await McpTestClient.connect(
      await passwordGrantToken(seed.userB)
    );
    try {
      const recalled = await mcp.callTool('recall', {
        query: 'which memory is visible only to e2e user A?',
        k: 20,
      });
      expect(recalled.isError ?? false).toBe(false);
      expect(contentText(recalled)).not.toContain(seed.rlsPrivateMemoryId);

      const briefing = await mcp.callTool('build_context', {
        topic: RLS_PRIVATE_MEMORY.content,
      });
      expect(briefing.isError ?? false).toBe(false);
      expect(contentText(briefing)).not.toContain(seed.rlsPrivateMemoryId);
    } finally {
      await mcp.close();
    }
  });

  test('@smoke another user cannot read the row via PostgREST either', async () => {
    const seed = await readSeedState();

    const asOwner = userRestClient(await passwordGrantToken(seed.userA));
    const owned = await asOwner
      .from('memories')
      .select('id')
      .eq('id', seed.rlsPrivateMemoryId);
    expect(owned.error).toBeNull();
    expect(owned.data).toHaveLength(1);

    const asStranger = userRestClient(await passwordGrantToken(seed.userB));
    const foreign = await asStranger
      .from('memories')
      .select('id')
      .eq('id', seed.rlsPrivateMemoryId);
    expect(foreign.error).toBeNull();
    expect(foreign.data).toHaveLength(0);
  });
});

test.describe('Roster is not enumerable', () => {
  const admin = (): SupabaseClient =>
    createClient(e2eEnv.supabaseUrl, e2eEnv.supabaseServiceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

  /** usr_ entity id behind an auth uuid, read past RLS with the service role. */
  const entityIdOf = async (authUserId: string): Promise<string> => {
    const { data, error } = await admin()
      .from('profiles')
      .select('id')
      .eq('user_id', authUserId)
      .single();
    expect(error).toBeNull();
    return (data as { id: string }).id;
  };

  /**
   * Makes `user` an admin member of `scope`, using the service role: the
   * fixture must not be built with the mechanism under test.
   */
  const joinScope = async (user: E2EUser, scope: string): Promise<void> => {
    const { error } = await admin()
      .from('scope_members')
      .upsert(
        { scope, user_id: await entityIdOf(user.id), role: 'admin' },
        { onConflict: 'scope,user_id' }
      );
    expect(error).toBeNull();
  };

  /**
   * Two accounts that must stay invisible to user B, named rather than counted
   * — a bound on how MANY rows come back cannot fail when a predicate widens
   * only partially, and comparing two surfaces that share the same helper
   * cannot fail at all.
   *
   * `stranger` shares nothing with user B. `sibling` sits in a DIFFERENT scope
   * under the same root as user B's, which is what a predicate relaxed from
   * "same scope" to "anywhere beneath a shared root" would wrongly admit.
   */
  const outsiders = async (): Promise<{
    stranger: E2EUser;
    sibling: E2EUser;
  }> => {
    const [stranger, sibling] = await Promise.all([
      provisionE2EUser('roster-stranger@zm.e2e'),
      provisionE2EUser('roster-sibling@zm.e2e'),
    ]);
    const seed = await readSeedState();
    await joinScope(seed.userB, 'proj.roster_probe_mine');
    await joinScope(sibling, 'proj.roster_probe_theirs');
    return { stranger, sibling };
  };

  test('@smoke a signed-in user cannot list other accounts through PostgREST', async () => {
    const seed = await readSeedState();
    const { stranger, sibling } = await outsiders();

    const [selfId, strangerId, siblingId] = await Promise.all([
      entityIdOf(seed.userB.id),
      entityIdOf(stranger.id),
      entityIdOf(sibling.id),
    ]);

    const rest = userRestClient(await passwordGrantToken(seed.userB));
    const { data, error } = await rest.from('profiles').select('id, user_id');
    expect(error).toBeNull();
    const visibleIds = ((data ?? []) as { id: string }[]).map((row) => row.id);

    expect(visibleIds).toContain(selfId);
    expect(visibleIds).not.toContain(strangerId);
    expect(visibleIds).not.toContain(siblingId);
  });

  test('@smoke the member-identity RPC names no one the caller does not share a scope with', async () => {
    const seed = await readSeedState();
    const { stranger, sibling } = await outsiders();

    const rest = userRestClient(await passwordGrantToken(seed.userB));
    const { data, error } = await rest.rpc('scope_member_identities');
    expect(error).toBeNull();
    const emails = ((data ?? []) as { email: string }[]).map(
      (row) => row.email
    );

    // The addresses this replaced a full account listing with: the caller's
    // own, and co-members' — never an outsider's.
    expect(emails).toContain(seed.userB.email);
    expect(emails).not.toContain(stranger.email);
    expect(emails).not.toContain(sibling.email);
  });

  test('@smoke resolving a member candidate answers one address, and only for a scope admin', async () => {
    const seed = await readSeedState();
    const tokenB = await passwordGrantToken(seed.userB);
    const mcp = await McpTestClient.connect(tokenB);
    let scope: string;
    try {
      const write = await mcp.callTool('remember', {
        content: 'roster marker: candidate resolution probe fact',
        kind: 'fact',
        scope: 'proj.roster_probe',
      });
      expect(write.isError ?? false).toBe(false);
      scope = firstJson<{ scope: string }>(write).scope;
    } finally {
      await mcp.close();
    }

    const asAdmin = userRestClient(tokenB);
    const resolved = await asAdmin.rpc('resolve_scope_member_candidate', {
      p_scope: scope,
      p_email: seed.userA.email.toUpperCase(),
    });
    expect(resolved.error).toBeNull();
    expect(String(resolved.data)).toMatch(/^usr_/);

    // An address with no account resolves to nothing rather than erroring —
    // the caller learns about the one address they typed, and nothing else.
    const unknown = await asAdmin.rpc('resolve_scope_member_candidate', {
      p_scope: scope,
      p_email: 'no-such-account@zm.e2e',
    });
    expect(unknown.error).toBeNull();
    expect(unknown.data).toBeNull();

    // A caller who does not administer the scope is refused outright, so the
    // RPC cannot be used as an account-existence oracle by just anyone.
    const asStranger = userRestClient(await passwordGrantToken(seed.userA));
    const refused = await asStranger.rpc('resolve_scope_member_candidate', {
      p_scope: scope,
      p_email: seed.userB.email,
    });
    expect(refused.error).not.toBeNull();
  });
});
