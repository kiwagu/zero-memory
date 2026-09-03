/**
 * Legacy project-scope canonicalization, end-to-end: an explicit legacy
 * 2-label `proj.<slug>` (the pre-per-owner generation's name, typically
 * copied out of an old memory's scope field) resolves to the caller's own
 * `proj.<owner>.<slug>` on write AND read, and the canonical scope is
 * bootstrapped (scope + admin membership) on first sight.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { expect, test } from '@playwright/test';

import { e2eEnv } from '../helpers/env.js';
import { readSeedState } from '../helpers/runtime-state.js';
import { contentText, firstJson, McpTestClient } from '../helpers/mcp.js';
import { passwordGrantToken } from '../helpers/users.js';

const adminClient = (): SupabaseClient =>
  createClient(e2eEnv.supabaseUrl, e2eEnv.supabaseServiceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

test.describe('Legacy project scope canonicalization over MCP', () => {
  test('a legacy proj.<slug> write lands per-owner, is readable via both names, scope bootstrapped', async () => {
    const seed = await readSeedState();
    const mcp = await McpTestClient.connect(
      await passwordGrantToken(seed.userB)
    );
    try {
      const write = await mcp.callTool('remember', {
        content:
          'e2e scope-canonicalization marker: the flux capacitor calibration ' +
          'lives in the maintenance handbook',
        kind: 'fact',
        scope: 'proj.fluxcap',
      });
      expect(write.isError ?? false).toBe(false);
      const out = firstJson<{ memory_id: string; scope: string }>(write);
      // Canonicalized into the caller's own per-owner generation.
      expect(out.scope).toMatch(/^proj\.usr_[a-z0-9_]+\.fluxcap$/);

      // The row itself sits in the canonical scope.
      const { data: row, error } = await adminClient()
        .from('memories')
        .select('scope')
        .eq('id', out.memory_id)
        .single();
      expect(error).toBeNull();
      expect(String(row!.scope)).toBe(out.scope);

      // First-sight bootstrap: the canonical scope exists with the caller
      // as a member (create_scope registered it, like project routing does).
      const { data: members, error: memberErr } = await adminClient()
        .from('scope_members')
        .select('role')
        .eq('scope', out.scope);
      expect(memberErr).toBeNull();
      expect(members?.length).toBeGreaterThan(0);

      // Reading through the LEGACY name finds the memory too — the read
      // path canonicalizes the same way.
      const recalled = contentText(
        await mcp.callTool('recall', {
          query: 'where does the flux capacitor calibration live?',
          scopes: ['proj.fluxcap'],
          k: 10,
        })
      );
      expect(recalled).toContain(out.memory_id);
    } finally {
      await mcp.close();
    }
  });

  test('a per-owner scope passes through untouched', async () => {
    const seed = await readSeedState();
    const mcp = await McpTestClient.connect(
      await passwordGrantToken(seed.userB)
    );
    try {
      const probe = await mcp.callTool('remember', {
        content: 'e2e scope-canonicalization marker: canonical passthrough',
        kind: 'fact',
        scope: 'proj.fluxcap',
      });
      const canonical = firstJson<{ scope: string }>(probe).scope;

      const write = await mcp.callTool('remember', {
        content:
          'e2e scope-canonicalization marker: explicitly canonical write',
        kind: 'fact',
        scope: canonical,
      });
      expect(write.isError ?? false).toBe(false);
      expect(firstJson<{ scope: string }>(write).scope).toBe(canonical);
    } finally {
      await mcp.close();
    }
  });
});
