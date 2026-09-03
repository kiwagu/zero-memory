/**
 * The dashboard's LLM-free promote path. The SECURITY DEFINER
 * RPC public.promote_memory_to_rule lets an owner turn one of their OWN
 * memories into a promoted rule_candidate (rule_text = the memory's own text),
 * gated by ownership. Exercised under a real user JWT (the same PostgREST
 * surface the web server action uses): own-promote succeeds, a stranger is
 * refused, and re-promoting a revoked rule brings it back.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { expect, test } from '@playwright/test';

import { e2eEnv } from '../helpers/env.js';
import { firstJson, McpTestClient } from '../helpers/mcp.js';
import { readSeedState } from '../helpers/runtime-state.js';
import { passwordGrantToken, userRestClient } from '../helpers/users.js';

const adminClient = (): SupabaseClient =>
  createClient(e2eEnv.supabaseUrl, e2eEnv.supabaseServiceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

const ruleRow = async (memoryId: string) => {
  const { data } = await adminClient()
    .from('rule_candidates')
    .select('status, target_layer, applies_scope, rule_text, revoked_at')
    .eq('memory_id', memoryId)
    .maybeSingle();
  return data;
};

/**
 * Create an owned memory via MCP and return its id. The scope is always named:
 * a write with no target is refused, since the server never guesses one.
 */
const rememberAs = async (
  token: string,
  content: string,
  scope = 'personal'
): Promise<string> => {
  const mcp = await McpTestClient.connect(token);
  try {
    const write = await mcp.callTool('remember', {
      content,
      kind: 'preference',
      scope,
    });
    return firstJson<{ memory_id: string }>(write).memory_id;
  } finally {
    await mcp.close();
  }
};

test.describe('promote_memory_to_rule (dashboard, LLM-free)', () => {
  test('owner promotes their own personal memory to a General rule', async () => {
    const seed = await readSeedState();
    const token = await passwordGrantToken(seed.userB);
    const memoryId = await rememberAs(
      token,
      'promote-memory marker: prefer bun over npm everywhere'
    );

    const { error } = await userRestClient(token).rpc(
      'promote_memory_to_rule',
      { p_memory_id: memoryId }
    );
    expect(error).toBeNull();

    const row = await ruleRow(memoryId);
    expect(row?.status).toBe('promoted');
    expect(row?.target_layer).toBe('user');
    expect(row?.applies_scope).toBeNull();
    expect(row?.rule_text).toContain('prefer bun over npm');
  });

  test('refuses a memory the caller does not own', async () => {
    const seed = await readSeedState();
    const ownerToken = await passwordGrantToken(seed.userA);
    const memoryId = await rememberAs(
      ownerToken,
      'promote-memory marker: user A private memory'
    );

    const strangerToken = await passwordGrantToken(seed.userB);
    const { error } = await userRestClient(strangerToken).rpc(
      'promote_memory_to_rule',
      { p_memory_id: memoryId }
    );
    expect(error).not.toBeNull();
    // No candidacy was created for A's memory by the stranger's call.
    expect(await ruleRow(memoryId)).toBeNull();
  });

  test('refuses to revive a dismissed candidacy unless forced', async () => {
    const seed = await readSeedState();
    const token = await passwordGrantToken(seed.userB);
    const memoryId = await rememberAs(
      token,
      'promote-memory marker: dismissed then force-promoted'
    );
    const rest = userRestClient(token);

    const first = await rest.rpc('promote_memory_to_rule', {
      p_memory_id: memoryId,
    });
    expect(first.error).toBeNull();

    // The owner deliberately dismisses it as a rule.
    await adminClient()
      .from('rule_candidates')
      .update({ status: 'dismissed', resolution: 'dismissed_by_owner' })
      .eq('memory_id', memoryId);

    // A routine promote must not silently overturn that decision.
    const guarded = await rest.rpc('promote_memory_to_rule', {
      p_memory_id: memoryId,
    });
    expect(guarded.error).not.toBeNull();
    expect(guarded.error?.message).toContain('dismissed');
    expect((await ruleRow(memoryId))?.status).toBe('dismissed');

    // With force, it comes back.
    const forced = await rest.rpc('promote_memory_to_rule', {
      p_memory_id: memoryId,
      p_force: true,
    });
    expect(forced.error).toBeNull();
    expect((await ruleRow(memoryId))?.status).toBe('promoted');
  });

  test('re-promoting a revoked rule brings it back (clears the revoke)', async () => {
    const seed = await readSeedState();
    const token = await passwordGrantToken(seed.userB);
    const memoryId = await rememberAs(
      token,
      'promote-memory marker: re-promote clears the revoke'
    );
    const rest = userRestClient(token);

    const first = await rest.rpc('promote_memory_to_rule', {
      p_memory_id: memoryId,
    });
    expect(first.error).toBeNull();

    // Simulate the owner having revoked it from /rules.
    await adminClient()
      .from('rule_candidates')
      .update({
        status: 'revoked',
        resolution: 'revoked',
        revoked_at: new Date().toISOString(),
        revoke_reason: 'test revoke',
      })
      .eq('memory_id', memoryId);
    expect((await ruleRow(memoryId))?.revoked_at).not.toBeNull();

    const second = await rest.rpc('promote_memory_to_rule', {
      p_memory_id: memoryId,
    });
    expect(second.error).toBeNull();

    const row = await ruleRow(memoryId);
    expect(row?.status).toBe('promoted');
    expect(row?.revoked_at).toBeNull();
  });
});
