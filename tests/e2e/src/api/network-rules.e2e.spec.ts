/**
 * Network-served rules, end-to-end.
 *
 * The instructions channel only ANNOUNCES that standing rules exist (clients
 * cap it, and one rule can exhaust the budget); the briefing's rules[] is what
 * carries their text in full — General and project rules merged, PINNED first
 * and flagged, exempt from the delivery cap and TTL. These specs pin down that
 * split, the pin's guarantee, and the RLS boundary around all of it.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { expect, test } from '@playwright/test';
import { e2eEnv } from '../helpers/env.js';
import { readSeedState } from '../helpers/runtime-state.js';
import { contentText, firstJson, McpTestClient } from '../helpers/mcp.js';
import { passwordGrantToken } from '../helpers/users.js';

const RULE_TEXT =
  'network-rules marker: always validate on the e2e stack before any merge.';

interface BriefedRule {
  text: string;
  pinned: boolean;
}

const adminClient = (): SupabaseClient =>
  createClient(e2eEnv.supabaseUrl, e2eEnv.supabaseServiceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

/** Seeds a promoted user-layer rule anchored to a fresh memory of user B. */
async function seedPromotedRule(
  token: string,
  overrides: {
    anchorContent?: string;
    ruleText?: string;
    promotedAt?: Date;
    pinned?: boolean;
  } = {}
): Promise<string> {
  const mcp = await McpTestClient.connect(token);
  let memoryId: string;
  try {
    const write = await mcp.callTool('remember', {
      content:
        overrides.anchorContent ??
        'network-rules marker: anchor memory for the promoted rule',
      kind: 'convention',
      scope: 'personal',
    });
    expect(write.isError ?? false).toBe(false);
    memoryId = firstJson<{ memory_id: string }>(write).memory_id;
  } finally {
    await mcp.close();
  }

  const { data, error } = await adminClient()
    .from('rule_candidates')
    .insert({
      memory_id: memoryId,
      status: 'promoted',
      resolution: 'promoted',
      promoted_at: (overrides.promotedAt ?? new Date()).toISOString(),
      resolved_at: new Date().toISOString(),
      rule_text: overrides.ruleText ?? RULE_TEXT,
      target_layer: 'user',
      pinned: overrides.pinned ?? false,
      useful_sessions: 3,
      window_days: 14,
    })
    .select('id')
    .single();
  expect(error).toBeNull();
  return data!.id as string;
}

/** The rules a briefing delivers to this caller, in delivery order. */
async function briefedRules(
  mcp: McpTestClient,
  topic: string
): Promise<BriefedRule[]> {
  const briefed = await mcp.callTool('build_context', {
    topic,
    briefing: true,
  });
  expect(briefed.isError ?? false).toBe(false);
  return firstJson<{ rules: BriefedRule[] }>(briefed).rules;
}

test.describe('Standing rules over MCP', () => {
  test('the briefing carries a promoted rule in full; revoke removes it', async () => {
    const seed = await readSeedState();
    const token = await passwordGrantToken(seed.userB);
    const ruleId = await seedPromotedRule(token);

    const mcp = await McpTestClient.connect(token);
    try {
      // This test client declares no documented instructions cap, so the
      // protocol itself carries the rule — no hook, plugin or tool call
      // needed. The router still leads the block.
      const instructions = mcp.instructions() ?? '';
      expect(instructions).toContain('OWNER RULES');
      expect(instructions).toContain(RULE_TEXT);
      expect(instructions.indexOf('build_context')).toBeLessThan(
        instructions.indexOf('OWNER RULES')
      );

      // The briefing re-delivers the same text, for clients that truncate.
      const rules = await briefedRules(mcp, 'anything at all');
      expect(rules.map((rule) => rule.text)).toContain(RULE_TEXT);
    } finally {
      await mcp.close();
    }

    // A stranger never sees it (RLS on the rules read).
    const stranger = await McpTestClient.connect(
      await passwordGrantToken(seed.userA)
    );
    try {
      const rules = await briefedRules(stranger, 'anything at all');
      expect(rules.map((rule) => rule.text)).not.toContain(RULE_TEXT);
    } finally {
      await stranger.close();
    }

    // Revoke: the rule drops out of the briefing.
    const { error } = await adminClient()
      .from('rule_candidates')
      .update({ revoked_at: new Date().toISOString() })
      .eq('id', ruleId);
    expect(error).toBeNull();
    const after = await McpTestClient.connect(token);
    try {
      const rules = await briefedRules(after, 'anything at all');
      expect(rules.map((rule) => rule.text)).not.toContain(RULE_TEXT);
    } finally {
      await after.close();
    }
  });

  test('a promoted rule past the delivery TTL drops out — unless pinned', async () => {
    const seed = await readSeedState();
    const token = await passwordGrantToken(seed.userB);
    const STALE = 'network-rules marker: stale rule past the delivery ttl.';
    const STALE_PINNED =
      'network-rules marker: stale but pinned, must still arrive.';
    // Promoted 200 days ago — well past the 90-day soft-TTL.
    const old = new Date(Date.now() - 200 * 86_400_000);

    await seedPromotedRule(token, {
      anchorContent: 'network-rules marker: anchor for a stale rule',
      ruleText: STALE,
      promotedAt: old,
    });
    await seedPromotedRule(token, {
      anchorContent: 'network-rules marker: anchor for a stale pinned rule',
      ruleText: STALE_PINNED,
      promotedAt: old,
      pinned: true,
    });

    const mcp = await McpTestClient.connect(token);
    try {
      const texts = (await briefedRules(mcp, 'anything at all')).map(
        (rule) => rule.text
      );
      expect(texts).not.toContain(STALE);
      // The pin is a standing decision: it does not expire by age.
      expect(texts).toContain(STALE_PINNED);
    } finally {
      await mcp.close();
    }
  });

  test('pinned rules lead the array and carry the flag', async () => {
    const seed = await readSeedState();
    const token = await passwordGrantToken(seed.userB);
    const OLDER_PINNED = 'network-rules marker: older but pinned.';
    const NEWER_UNPINNED = 'network-rules marker: newer but unpinned.';

    await seedPromotedRule(token, {
      anchorContent: 'network-rules marker: anchor for the older pinned rule',
      ruleText: OLDER_PINNED,
      promotedAt: new Date(Date.now() - 86_400_000),
      pinned: true,
    });
    await seedPromotedRule(token, {
      anchorContent: 'network-rules marker: anchor for the newer unpinned rule',
      ruleText: NEWER_UNPINNED,
    });

    const mcp = await McpTestClient.connect(token);
    try {
      const rules = await briefedRules(mcp, 'anything at all');
      const pinnedAt = rules.findIndex((rule) => rule.text === OLDER_PINNED);
      const unpinnedAt = rules.findIndex(
        (rule) => rule.text === NEWER_UNPINNED
      );
      expect(pinnedAt).toBeGreaterThanOrEqual(0);
      expect(unpinnedAt).toBeGreaterThanOrEqual(0);
      // Pinned wins over newest-first — the warmest position is the pin's.
      expect(pinnedAt).toBeLessThan(unpinnedAt);
      expect(rules[pinnedAt]!.pinned).toBe(true);
      expect(rules[unpinnedAt]!.pinned).toBe(false);
    } finally {
      await mcp.close();
    }
  });
});

test.describe('Project-layer rules ride the briefing pack', () => {
  test('a promoted project rule reaches only its own project briefing', async () => {
    const seed = await readSeedState();
    const token = await passwordGrantToken(seed.userB);
    const PROJECT_RULE =
      'project-rules marker: run the catalog importer before edits.';

    // Anchor memory in a concrete project scope (canonicalized per-owner).
    const mcp = await McpTestClient.connect(token);
    let memoryId: string;
    let projectScope: string;
    try {
      const write = await mcp.callTool('remember', {
        content: 'project-rules marker: anchor fact in the ruled project',
        kind: 'convention',
        scope: 'proj.ruled_project',
      });
      expect(write.isError ?? false).toBe(false);
      const out = firstJson<{ memory_id: string; scope: string }>(write);
      memoryId = out.memory_id;
      projectScope = out.scope;

      const { error } = await adminClient().from('rule_candidates').insert({
        memory_id: memoryId,
        status: 'promoted',
        resolution: 'promoted',
        promoted_at: new Date().toISOString(),
        resolved_at: new Date().toISOString(),
        rule_text: PROJECT_RULE,
        target_layer: 'project',
        useful_sessions: 3,
        window_days: 14,
      });
      expect(error).toBeNull();

      // Briefing the ruled project carries the rule as a STANDING RULES block.
      const briefed = await mcp.callTool('build_context', {
        topic: 'anything about the ruled project',
        briefing: true,
        scopes: [projectScope],
      });
      expect(briefed.isError ?? false).toBe(false);
      const rules = firstJson<{ rules: BriefedRule[] }>(briefed).rules;
      expect(rules.map((rule) => rule.text)).toContain(PROJECT_RULE);
      // The pack is also what the hook renders, so the text must be in it.
      expect(contentText(briefed)).toContain(PROJECT_RULE);

      // A DIFFERENT project's briefing stays unruled.
      const other = await mcp.callTool('remember', {
        content: 'project-rules marker: unrelated project anchor',
        kind: 'fact',
        scope: 'proj.unruled_project',
      });
      const otherScope = firstJson<{ scope: string }>(other).scope;
      const otherBriefing = await mcp.callTool('build_context', {
        topic: 'anything about the other project',
        briefing: true,
        scopes: [otherScope],
      });
      const otherRules = firstJson<{ rules: BriefedRule[] }>(
        otherBriefing
      ).rules;
      expect(otherRules.map((rule) => rule.text)).not.toContain(PROJECT_RULE);

      // ADDRESSED rule: anchored in the PERSONAL scope but explicitly
      // addressed to the ruled project via applies_scope — it must arrive in
      // that project's briefing (the addressing tactic's whole point).
      const ADDRESSED_RULE =
        'project-rules marker: addressed rule from a personal anchor.';
      const personal = await mcp.callTool('remember', {
        content: 'project-rules marker: personal anchor for an addressed rule',
        kind: 'preference',
        scope: 'personal',
      });
      const personalId = firstJson<{ memory_id: string }>(personal).memory_id;
      const { error: addressedErr } = await adminClient()
        .from('rule_candidates')
        .insert({
          memory_id: personalId,
          status: 'promoted',
          resolution: 'promoted',
          promoted_at: new Date().toISOString(),
          resolved_at: new Date().toISOString(),
          rule_text: ADDRESSED_RULE,
          target_layer: 'project',
          applies_scope: projectScope,
          useful_sessions: 3,
          window_days: 14,
        });
      expect(addressedErr).toBeNull();

      const rebriefed = await mcp.callTool('build_context', {
        topic: 'anything about the ruled project again',
        briefing: true,
        scopes: [projectScope],
      });
      const rebriefedRules = firstJson<{ rules: BriefedRule[] }>(
        rebriefed
      ).rules;
      expect(rebriefedRules.map((rule) => rule.text)).toContain(ADDRESSED_RULE);
    } finally {
      await mcp.close();
    }
  });
});
