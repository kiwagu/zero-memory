/**
 * On-demand rule promotion, end-to-end: promote_rule turns one owned memory
 * into a PROMOTED rule immediately (bypassing earned usefulness) — General by
 * default, project-addressed with applies_scope — and refuses a memory the
 * caller does not own. Uses an explicit rule_text so the keyless e2e stack
 * never needs the distiller LLM.
 */
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

const ruleRow = async (memoryId: string) => {
  const { data } = await adminClient()
    .from('rule_candidates')
    .select('status, target_layer, applies_scope, rule_text, useful_sessions')
    .eq('memory_id', memoryId)
    .maybeSingle();
  return data;
};

test.describe('promote_rule (on-demand) over MCP', () => {
  test('promotes an owned memory to a General rule immediately', async () => {
    const seed = await readSeedState();
    const mcp = await McpTestClient.connect(
      await passwordGrantToken(seed.userB)
    );
    try {
      const write = await mcp.callTool('remember', {
        content: 'promote-rule marker: prefer bun over npm in every workspace',
        kind: 'preference',
        scope: 'personal',
      });
      const memoryId = firstJson<{ memory_id: string }>(write).memory_id;

      const promoted = await mcp.callTool('promote_rule', {
        memory_id: memoryId,
        rule_text: 'promote-rule marker: always prefer bun over npm.',
      });
      expect(promoted.isError ?? false).toBe(false);
      const out = firstJson<{
        target_layer: string;
        applies_scope: string | null;
        status: string;
        delivery_note: string;
      }>(promoted);
      expect(out.status).toBe('promoted');
      expect(out.target_layer).toBe('user');
      expect(out.applies_scope).toBeNull();
      // The response tells the caller WHEN the rule reaches sessions.
      expect(out.delivery_note).toContain('NEW sessions');

      const row = await ruleRow(memoryId);
      expect(row?.status).toBe('promoted');
      expect(row?.target_layer).toBe('user');
      expect(row?.rule_text).toContain('always prefer bun over npm');
      expect(row?.useful_sessions).toBe(0);

      // This same session sees its freshly promoted General rule in the next
      // briefing — instructions are frozen at connect, the briefing is not.
      const briefing = await mcp.callTool('build_context', {
        topic: 'bun vs npm preference',
        briefing: true,
      });
      const brief = firstJson<{ rules: { text: string; pinned: boolean }[] }>(
        briefing
      );
      expect(brief.rules.map((rule) => rule.text)).toContain(
        'promote-rule marker: always prefer bun over npm.'
      );
    } finally {
      await mcp.close();
    }
  });

  test('addresses a PROJECT rule when applies_scope is given', async () => {
    const seed = await readSeedState();
    const mcp = await McpTestClient.connect(
      await passwordGrantToken(seed.userB)
    );
    try {
      // Anchor + a real project scope (canonicalized per-owner on write).
      const anchor = await mcp.callTool('remember', {
        content: 'promote-rule marker: project fact for addressed promotion',
        kind: 'convention',
        scope: 'proj.promote_probe',
      });
      const anchorOut = firstJson<{ memory_id: string; scope: string }>(anchor);

      const promoted = await mcp.callTool('promote_rule', {
        memory_id: anchorOut.memory_id,
        applies_scope: anchorOut.scope,
        rule_text: 'promote-rule marker: run the probe before edits.',
      });
      expect(promoted.isError ?? false).toBe(false);
      const out = firstJson<{ target_layer: string; applies_scope: string }>(
        promoted
      );
      expect(out.target_layer).toBe('project');
      expect(out.applies_scope).toBe(anchorOut.scope);

      const row = await ruleRow(anchorOut.memory_id);
      expect(String(row?.applies_scope)).toBe(anchorOut.scope);
    } finally {
      await mcp.close();
    }
  });

  test('refuses a memory the caller does not own', async () => {
    const seed = await readSeedState();
    const owner = await McpTestClient.connect(
      await passwordGrantToken(seed.userA)
    );
    const stranger = await McpTestClient.connect(
      await passwordGrantToken(seed.userB)
    );
    try {
      const write = await owner.callTool('remember', {
        content: 'promote-rule marker: user A private memory',
        kind: 'preference',
        scope: 'personal',
      });
      const memoryId = firstJson<{ memory_id: string }>(write).memory_id;

      const attempt = await stranger.callTool('promote_rule', {
        memory_id: memoryId,
        rule_text: 'promote-rule marker: should never apply',
      });
      expect(attempt.isError ?? false).toBe(true);

      // No candidacy was created for A's memory.
      expect(await ruleRow(memoryId)).toBeNull();
    } finally {
      await stranger.close();
      await owner.close();
    }
  });
});
