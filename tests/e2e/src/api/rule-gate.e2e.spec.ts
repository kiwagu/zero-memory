/**
 * The rule gate, end-to-end on the isolated stack: with the gate live and a
 * deterministic judge, an agent call's unpinned rules arrive at the level the
 * judge's probability puts them in, pinned rules stay whole, a hook briefing
 * (max_tokens) is judged only against the card its conversation is bound to,
 * an account that never enabled the gate gets every rule whole, and a
 * headlined rule is one resource read away.
 *
 * The judge is the server's test double: it answers each rule with the
 * `[p=0.xx]` marker written into the rule's condition. Every fixture text
 * opens with the run tag, which puts its first period past the twenty
 * characters a headline always keeps, so each rule's headline is the clause
 * before that period.
 *
 * The spec runs on accounts of its own: the settings page spec turns the
 * judge on and off for the seeded accounts, and a run with two workers would
 * let the two specs change the same account's switch under each other.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { expect, test } from '@playwright/test';

import { e2eEnv } from '../helpers/env.js';
import { firstJson, McpTestClient } from '../helpers/mcp.js';
import {
  entityIdOf,
  passwordGrantToken,
  provisionE2EUser,
} from '../helpers/users.js';

interface GatedRule {
  id?: string;
  text: string;
  pinned: boolean;
  level?: 'full' | 'gate' | 'headline';
  applies_when?: string;
}

interface Pack {
  rules: GatedRule[];
  rule_gate?: {
    mode: string;
    judge_unavailable: boolean;
    levels: { full: number; gate: number; headline: number };
    chars_baseline: number;
    chars_delivered: number;
    rules: Array<{
      id: string;
      p: number | null;
      level: string;
      pinned: boolean;
    }>;
  };
  project_scope?: string;
  session?: { thread?: string };
  work?: {
    bound_card?: { number: number } | null;
    continuation?: unknown;
  };
}

interface ToolCallMetadata {
  tool: string;
  rule_id?: string;
  found?: boolean;
  rule_gate?: {
    rules: Array<{ id: string; p: number | null; level: string }>;
  };
}

const adminClient = (): SupabaseClient =>
  createClient(e2eEnv.supabaseUrl, e2eEnv.supabaseServiceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

const TAG = `gate-${Date.now()}`;
const REPO = 'acme/memory-service';

/** The account that turns the gate on. */
const GATED_EMAIL = 'rule-gate@zm.e2e';
/** The account that never turns it on, and the stranger to the first. */
const UNGATED_EMAIL = 'rule-gate-off@zm.e2e';

const PINNED_TEXT = `${TAG} PINNED RULE. Always whole.`;
const FULL_TEXT = `${TAG} COMMIT RULE. Sign every commit before a push.`;
const GATE_TEXT = `${TAG} CACHE RULE. Warm the cache before a load test.`;
const HEADLINE_TEXT = `${TAG} REPORT RULE. Keep each weekly report to one page.`;

/**
 * A promoted General rule for the session's user; returns its rlc_ id. The
 * anchor memories are on unrelated subjects: two near-identical anchors
 * would be deduplicated into one memory, and a memory holds one rule only.
 */
async function seedRule(
  mcp: McpTestClient,
  rule: {
    anchor: string;
    ruleText: string;
    appliesWhen?: string;
    pinned?: boolean;
  }
): Promise<string> {
  const write = await mcp.callTool('remember', {
    content: `${TAG}: ${rule.anchor}`,
    kind: 'convention',
    scope: 'personal',
  });
  expect(write.isError ?? false).toBe(false);
  const memoryId = firstJson<{ memory_id: string }>(write).memory_id;
  const { data, error } = await adminClient()
    .from('rule_candidates')
    .insert({
      memory_id: memoryId,
      status: 'promoted',
      resolution: 'promoted',
      promoted_at: new Date().toISOString(),
      resolved_at: new Date().toISOString(),
      rule_text: rule.ruleText,
      applies_when: rule.appliesWhen ?? null,
      target_layer: 'user',
      pinned: rule.pinned ?? false,
      useful_sessions: 3,
      window_days: 14,
    })
    .select('id')
    .single();
  expect(error).toBeNull();
  return data!.id as string;
}

/** Revokes the spec's rules so later specs' briefings never carry them. */
async function revokeRules(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const { error } = await adminClient()
    .from('rule_candidates')
    .update({
      status: 'revoked',
      resolution: 'revoked',
      revoked_at: new Date().toISOString(),
      revoke_reason: 'e2e cleanup',
    })
    .in('id', ids);
  expect(error).toBeNull();
}

async function setGate(subjectId: string, enabled: boolean): Promise<void> {
  const admin = adminClient();
  const { error } = enabled
    ? await admin
        .from('judge_settings')
        .upsert(
          { subject_id: subjectId, enabled: true, provider: null },
          { onConflict: 'subject_id' }
        )
    : await admin.from('judge_settings').delete().eq('subject_id', subjectId);
  expect(error).toBeNull();
}

async function brief(
  mcp: McpTestClient,
  args: Record<string, unknown>
): Promise<Pack> {
  const result = await mcp.callTool('build_context', {
    briefing: true,
    ...args,
  });
  expect(result.isError ?? false).toBe(false);
  return firstJson<Pack>(result);
}

/**
 * Runs every cleanup step, in order, even when an earlier one fails. A failed
 * step is a soft failure: the test fails, but the error that stopped its body
 * stays the one reported first.
 */
async function restoreAll(
  steps: Array<[label: string, step: () => Promise<unknown>]>
): Promise<void> {
  for (const [label, step] of steps) {
    try {
      await step();
    } catch (error) {
      expect.soft(error, `cleanup: ${label}`).toBeUndefined();
    }
  }
}

/** The `mcp_tool_call` metadata the server wrote for a user since `since`. */
async function toolCallRows(
  userId: string,
  tool: string,
  since: string
): Promise<ToolCallMetadata[]> {
  const { data, error } = await adminClient()
    .from('usage_events')
    .select('metadata')
    .eq('event_type', 'mcp_tool_call')
    .eq('user_id', userId)
    .contains('metadata', { tool })
    .gte('occurred_at', since);
  expect(error).toBeNull();
  return (data ?? []).map((row) => row.metadata as ToolCallMetadata);
}

/** The input tokens of each judgment metered for a user since `since`, oldest first. */
async function judgeInputTokens(
  userId: string,
  since: string
): Promise<number[]> {
  const { data, error } = await adminClient()
    .from('usage_events')
    .select('metadata, occurred_at')
    .eq('event_type', 'llm_extraction')
    .eq('user_id', userId)
    .contains('metadata', { purpose: 'rule_gate' })
    .gte('occurred_at', since)
    .order('occurred_at', { ascending: true });
  expect(error).toBeNull();
  return (data ?? []).map(
    (row) => (row.metadata as { input_tokens: number }).input_tokens
  );
}

test.describe('Rule gate over MCP @smoke', () => {
  test('levels follow the judge, pinned stay whole, hook calls are judged only with a card, one rule is readable by id', async () => {
    const gated = await provisionE2EUser(GATED_EMAIL);
    const subject = await entityIdOf(gated.id);
    const since = new Date().toISOString();
    const seeded: string[] = [];
    let cardId: string | undefined;

    const mcp = await McpTestClient.connect(await passwordGrantToken(gated));
    try {
      const pinnedId = await seedRule(mcp, {
        anchor: 'the importer batches uploads in groups of fifty',
        ruleText: PINNED_TEXT,
        pinned: true,
      });
      seeded.push(pinnedId);
      const fullId = await seedRule(mcp, {
        anchor: 'deploys freeze on Friday afternoons',
        ruleText: FULL_TEXT,
        appliesWhen: 'any task that commits [p=0.9]',
      });
      seeded.push(fullId);
      const gateId = await seedRule(mcp, {
        anchor: 'the cold bucket keeps ninety days of exports',
        ruleText: GATE_TEXT,
        appliesWhen: 'any task that touches a stack [p=0.5]',
      });
      seeded.push(gateId);
      const headlineId = await seedRule(mcp, {
        anchor: 'the report build retries twice before paging',
        ruleText: HEADLINE_TEXT,
        appliesWhen: 'planning work [p=0.1]',
      });
      seeded.push(headlineId);
      await setGate(subject, true);

      // Agent call: a real topic, no budget.
      const pack = await brief(mcp, {
        topic: 'squash the branch and release it',
      });
      const byId = new Map(pack.rules.map((rule) => [rule.id, rule]));
      expect(byId.get(pinnedId)).toMatchObject({
        level: 'full',
        pinned: true,
        text: PINNED_TEXT,
      });
      expect(byId.get(fullId)).toMatchObject({
        level: 'full',
        text: FULL_TEXT,
      });
      // The condition travels only on a gate line.
      expect(byId.get(fullId)).not.toHaveProperty('applies_when');
      expect(byId.get(gateId)).toMatchObject({
        level: 'gate',
        text: `${TAG} CACHE RULE`,
        applies_when: 'any task that touches a stack [p=0.5]',
      });
      expect(byId.get(headlineId)).toMatchObject({
        level: 'headline',
        text: `${TAG} REPORT RULE`,
      });
      expect(byId.get(headlineId)).not.toHaveProperty('applies_when');
      // Every rule stays named.
      for (const rule of pack.rules) {
        expect(rule.text.length).toBeGreaterThan(0);
      }
      // Pinned first, then by probability.
      const order = pack.rules
        .map((rule) => rule.id)
        .filter((id): id is string => id !== undefined && seeded.includes(id));
      expect(order).toEqual([pinnedId, fullId, gateId, headlineId]);
      // The block says what the gate did, consistent with the delivery.
      expect(pack.rule_gate).toMatchObject({
        mode: 'live',
        judge_unavailable: false,
      });
      expect(pack.rule_gate!.chars_delivered).toBeLessThan(
        pack.rule_gate!.chars_baseline
      );
      const blockOf = (id: string) =>
        pack.rule_gate!.rules.find((rule) => rule.id === id);
      expect(blockOf(pinnedId)).toMatchObject({ p: null, pinned: true });
      expect(blockOf(headlineId)!.p).toBeCloseTo(0.1);
      expect(blockOf(headlineId)!.level).toBe('headline');

      // Hook call without a card: budgeted, project-name topic, a project
      // with no board work — never judged.
      const hint = `/tmp/zm-e2e-gate-${Date.now()}`;
      const conversation = `conv-${TAG}`;
      const hook = await brief(mcp, {
        topic: 'zero-memory',
        max_tokens: 1200,
        briefing_kind: 'session',
        project_hint: hint,
        conversation_id: conversation,
      });
      expect(hook.work?.bound_card ?? null).toBeNull();
      expect(hook.work?.continuation ?? null).toBeNull();
      expect(hook.rule_gate).toBeUndefined();
      expect(hook.rules.find((rule) => rule.id === headlineId)).toStrictEqual({
        id: headlineId,
        text: HEADLINE_TEXT,
        pinned: false,
      });
      expect(
        hook.rules.every(
          (rule) => rule.level === undefined || rule.level === 'full'
        )
      ).toBe(true);

      // Hook call with a bound card: judged against the card's statement.
      const thread = hook.session?.thread;
      expect(thread).toMatch(/^thr_/u);
      expect(hook.project_scope).toBeTruthy();
      const created = await mcp.callTool('card', {
        action: 'create',
        scope: hook.project_scope,
        title: 'Squash the branch and release it',
        type: 'task',
        no_links: 'e2e fixture',
        state: 'active',
        branch: { repo: REPO, name: `feature/${TAG}` },
      });
      expect(created.isError ?? false).toBe(false);
      const card = firstJson<{ card: { id: string; number: number } }>(
        created
      ).card;
      cardId = card.id;
      const attached = await mcp.callTool('card_log', {
        action: 'attach',
        card_id: card.id,
        ref_kind: 'thread',
        ref_target: thread,
      });
      expect(attached.isError ?? false).toBe(false);
      const hookArgs = {
        topic: 'zero-memory',
        max_tokens: 1200,
        briefing_kind: 'task',
        project_hint: hint,
        conversation_id: conversation,
        thread,
      };
      const bound = await brief(mcp, hookArgs);
      expect(bound.work?.bound_card?.number).toBe(card.number);
      expect(bound.rule_gate).toMatchObject({
        mode: 'live',
        judge_unavailable: false,
      });
      expect(bound.rules.find((rule) => rule.id === headlineId)).toMatchObject({
        level: 'headline',
        text: `${TAG} REPORT RULE`,
      });
      expect(bound.rules.find((rule) => rule.id === gateId)).toMatchObject({
        level: 'gate',
      });
      expect(bound.rules.find((rule) => rule.id === pinnedId)).toMatchObject({
        level: 'full',
        text: PINNED_TEXT,
      });

      // The judge also reads the card's body and latest steps, which the
      // briefing itself never carries: each one the card gains, it is asked
      // about. The e2e judge counts a request's size as its tokens, and
      // metering lands after the answer, so each judgment is awaited by when
      // it was asked.
      const judgedTokens = async (): Promise<number> => {
        const askedAt = new Date().toISOString();
        await brief(mcp, hookArgs);
        let tokens: number[] = [];
        await expect
          .poll(
            async () =>
              (tokens = await judgeInputTokens(subject, askedAt)).length
          )
          .toBe(1);
        return tokens[0]!;
      };
      const plain = await judgedTokens();
      const body = 'Read the header row before any data row. '.repeat(50);
      const edited = await mcp.callTool('card', {
        action: 'edit',
        card_id: card.id,
        body,
      });
      expect(edited.isError ?? false).toBe(false);
      const withBody = await judgedTokens();
      expect(withBody - plain).toBeGreaterThanOrEqual(
        Math.floor(body.length / 4)
      );
      const step = `Started the parser on the header row: ${'quoted fields, then escapes. '.repeat(20)}`;
      const noted = await mcp.callTool('card_log', {
        action: 'note',
        card_id: card.id,
        text: step,
      });
      expect(noted.isError ?? false).toBe(false);
      const withStep = await judgedTokens();
      // A step is read as its first 400 characters, not as a whole note.
      expect(withStep - withBody).toBeGreaterThanOrEqual(400 / 4);
      expect(withStep - withBody).toBeLessThan(Math.floor(step.length / 4));

      // The hook's secondary briefing leaves the judging to the primary one.
      const secondary = await brief(mcp, { ...hookArgs, judge_rules: false });
      expect(secondary.rule_gate).toBeUndefined();
      expect(
        secondary.rules.find((rule) => rule.id === headlineId)
      ).toMatchObject({ text: HEADLINE_TEXT });

      // The headlined rule in full, by id.
      const read = await mcp.readResourceJson<{ rule: GatedRule }>(
        `zm://rules/${headlineId}`
      );
      expect(read.rule).toMatchObject({
        id: headlineId,
        level: 'full',
        text: HEADLINE_TEXT,
        applies_when: 'planning work [p=0.1]',
      });
      await expect(
        mcp.readResourceJson('zm://rules/not-an-id')
      ).rejects.toThrow(/Not a rule id/u);

      // Another account cannot read it by id: absent and not-yours are the
      // same answer.
      const stranger = await McpTestClient.connect(
        await passwordGrantToken(await provisionE2EUser(UNGATED_EMAIL))
      );
      try {
        await expect(
          stranger.readResourceJson(`zm://rules/${headlineId}`)
        ).rejects.toThrow(/not found/u);
      } finally {
        await stranger.close();
      }

      // The delivery and the fetch were metered, content-free.
      await expect
        .poll(async () =>
          (await toolCallRows(subject, 'build_context', since))
            .flatMap((row) => row.rule_gate?.rules ?? [])
            .find((rule) => rule.id === headlineId)
        )
        .toMatchObject({ level: 'headline' });
      const judged = (await toolCallRows(subject, 'build_context', since))
        .filter((row) => row.rule_gate !== undefined)
        .map((row) => JSON.stringify(row));
      expect(judged.length).toBeGreaterThan(0);
      for (const row of judged) {
        expect(row).not.toContain(TAG);
      }
      await expect
        .poll(
          async () =>
            (await toolCallRows(subject, 'resource:rule', since)).filter(
              (row) => row.rule_id === headlineId && row.found === true
            ).length
        )
        .toBeGreaterThan(0);
    } finally {
      await restoreAll([
        ['turn the gate off', () => setGate(subject, false)],
        ['revoke the fixture rules', () => revokeRules(seeded)],
        [
          'archive the bound card',
          async () => {
            if (cardId === undefined) return;
            const archived = await mcp.callTool('card', {
              action: 'archive',
              card_id: cardId,
              reason: 'e2e fixture cleanup',
            });
            expect(archived.isError ?? false).toBe(false);
          },
        ],
        ['close the MCP client', () => mcp.close()],
      ]);
    }
  });

  test('an account that never enabled the gate gets every rule whole', async () => {
    const ungated = await provisionE2EUser(UNGATED_EMAIL);
    const { data: settings, error } = await adminClient()
      .from('judge_settings')
      .select('enabled')
      .eq('subject_id', await entityIdOf(ungated.id))
      .maybeSingle();
    expect(error).toBeNull();
    expect((settings as { enabled: boolean } | null)?.enabled ?? false).toBe(
      false
    );

    const mcp = await McpTestClient.connect(await passwordGrantToken(ungated));
    const seeded: string[] = [];
    try {
      const id = await seedRule(mcp, {
        anchor: 'the vacuum is skipped on the first of the month',
        ruleText: `${TAG} B RULE. Whole for B.`,
        appliesWhen: 'anything [p=0.1]',
      });
      seeded.push(id);
      const pack = await brief(mcp, { topic: 'anything at all' });
      expect(pack.rule_gate).toBeUndefined();
      const rule = pack.rules.find((entry) => entry.id === id);
      expect(rule).toStrictEqual({
        id,
        text: `${TAG} B RULE. Whole for B.`,
        pinned: false,
      });
    } finally {
      await restoreAll([
        ['revoke the fixture rule', () => revokeRules(seeded)],
        ['close the MCP client', () => mcp.close()],
      ]);
    }
  });
});
