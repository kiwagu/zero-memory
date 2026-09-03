/**
 * The memory card's sharing badge tells capability from fact: a memory in a
 * shareable scope (proj.*) reads "sharable" while the owner is its only member,
 * and flips to "shared" once someone else joins the scope. The dedicated
 * share-glyph button on the detail page opens a dialog listing who can see it.
 */
import { createClient } from '@supabase/supabase-js';
import { expect, test } from '@playwright/test';

import { e2eEnv } from '../helpers/env.js';
import { firstJson, McpTestClient } from '../helpers/mcp.js';
import { readSeedState } from '../helpers/runtime-state.js';
import { passwordGrantToken, userRestClient } from '../helpers/users.js';
import { signInThroughForm } from '../helpers/web.js';

test.describe('Memory sharing badge', () => {
  test('reads "sharable" while owner-only, "shared" once a member joins', async ({
    page,
  }) => {
    const seed = await readSeedState();
    const tokenA = await passwordGrantToken(seed.userA);

    const mcp = await McpTestClient.connect(tokenA);
    let memoryId: string;
    let scope: string;
    try {
      const write = await mcp.callTool('remember', {
        content: 'sharing-badge marker: capability-vs-fact flow',
        kind: 'fact',
        scope: 'proj.sharingbadge_probe',
      });
      expect(write.isError ?? false).toBe(false);
      const out = firstJson<{ memory_id: string; scope: string }>(write);
      memoryId = out.memory_id;
      scope = out.scope;

      // An explicit remember lands private even in a shareable scope; share it
      // so it carries visibility='shared' — the state whose badge is at stake.
      const shared = await mcp.callTool('share', {
        memory_id: memoryId,
        scope,
      });
      expect(shared.isError ?? false).toBe(false);
    } finally {
      await mcp.close();
    }

    await signInThroughForm(page, seed.userA);

    // Owner is the scope's only member: a capability to share, not the fact.
    await page.goto(`/memory/${memoryId}`);
    const badge = page.getByTestId('memory-visibility-badge');
    await expect(badge).toHaveText('sharable');

    // Deliberately add userB to the scope -> the memory is now truly shared.
    // scope_members.user_id is the usr_ entity id, not the auth uuid — resolve
    // it from profiles (service role, keyed by the auth uuid).
    const admin = createClient(
      e2eEnv.supabaseUrl,
      e2eEnv.supabaseServiceRoleKey,
      { auth: { persistSession: false, autoRefreshToken: false } }
    );
    const profile = await admin
      .from('profiles')
      .select('id')
      .eq('user_id', seed.userB.id)
      .single();
    expect(profile.error).toBeNull();
    const userBEntityId = (profile.data as { id: string }).id;

    const grant = await userRestClient(tokenA).rpc('add_scope_member', {
      p_scope: scope,
      p_user: userBEntityId,
      p_role: 'reader',
    });
    expect(grant.error).toBeNull();

    // The grant alone is a pending invitation and confers nothing, so the badge
    // must still read "sharable": announcing "shared" here would name a reach
    // the memory does not have. userB accepting is what makes it a fact.
    await page.reload();
    await expect(badge).toHaveText('sharable');

    const accepted = await userRestClient(
      await passwordGrantToken(seed.userB)
    ).rpc('accept_scope_invitation', { p_scope: scope });
    expect(accepted.error).toBeNull();

    await page.reload();
    await expect(badge).toHaveText('shared');

    // The share-glyph button reveals who the scope is shared with.
    await page.getByTestId('shared-with-trigger').click();
    const dialog = page.getByTestId('shared-with-dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText(seed.userB.email)).toBeVisible();
  });
});
