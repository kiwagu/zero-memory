/**
 * What an exhausted budget may and may not do.
 *
 * The promise this covers is the one that would be worth least if it were
 * only asserted in unit tests: running out of allowance pauses the making of
 * new memories and touches nothing else. Reading, recalling, briefing and
 * exporting what you already have keep working — your data is never held
 * behind an allowance — and the paused chunk stays pending rather than being
 * quietly marked done.
 *
 * The budget is applied by storing an allowance for a user this spec creates
 * for itself, so no other spec's user is affected and no server-wide
 * environment override is needed.
 */
import { createClient } from '@supabase/supabase-js';
import { expect, test } from '@playwright/test';

import { e2eEnv } from '../helpers/env.js';
import { contentText, firstJson, McpTestClient } from '../helpers/mcp.js';
import { passwordGrantToken, provisionE2EUser } from '../helpers/users.js';

const EMAIL = 'budget-degradation@zm.e2e';

const admin = () =>
  createClient(e2eEnv.supabaseUrl, e2eEnv.supabaseServiceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

/** The `usr_` entity id the ledger and allowances are keyed by. */
const entityIdOf = async (authUserId: string): Promise<string> => {
  const { data, error } = await admin()
    .from('profiles')
    .select('id')
    .eq('user_id', authUserId)
    .single();
  if (error) throw new Error(`no profile for ${authUserId}: ${error.message}`);
  return (data as { id: string }).id;
};

const setAllowance = async (
  subjectId: string,
  limitValue: number | null
): Promise<void> => {
  const { error } = await admin().from('policy_allowances').upsert({
    subject_id: subjectId,
    budget_id: 'extraction',
    limit_value: limitValue,
  });
  if (error) throw new Error(`could not store an allowance: ${error.message}`);
};

const clearAllowance = async (subjectId: string): Promise<void> => {
  await admin()
    .from('policy_allowances')
    .delete()
    .eq('subject_id', subjectId)
    .eq('budget_id', 'extraction');
};

/** Records spend directly, so the test does not have to burn real tokens. */
const recordSpend = async (
  subjectId: string,
  tokens: number,
  options: { ownKey?: boolean } = {}
): Promise<void> => {
  const { error } = await admin()
    .from('usage_events')
    .insert({
      user_id: subjectId,
      event_type: 'llm_extraction',
      quantity: tokens,
      unit: 'tokens',
      metadata: {
        purpose: 'extraction',
        model: 'test',
        ...(options.ownKey === true ? { own_key: true } : {}),
      },
    });
  if (error) throw new Error(`could not record spend: ${error.message}`);
};

test.describe('a caller on their own key is outside the budget', () => {
  test('sees no budget on the receipt, even under a ceiling', async () => {
    const user = await provisionE2EUser('own-key-vitrine@zm.e2e');
    const subjectId = await entityIdOf(user.id);
    const mcp = await McpTestClient.connect(await passwordGrantToken(user));
    const since = new Date(Date.now() - 3_600_000).toISOString();

    try {
      // A ceiling that is already spent: without a key of their own this
      // caller would see a budget, and generation would be paused.
      await setAllowance(subjectId, 1_000);
      await recordSpend(subjectId, 1_000);
      const capped = firstJson<{ budget: unknown }>(
        await mcp.callTool('session_receipt', { since })
      );
      expect(capped.budget).not.toBeNull();

      // Installing their own key takes them out of it entirely.
      const { error } = await admin().rpc('set_provider_credential', {
        p_subject_id: subjectId,
        p_provider: 'anthropic',
        p_api_key: 'sk-ant-own-key-for-the-vitrine-4242',
      });
      if (error) throw new Error(`could not store a key: ${error.message}`);

      const exempt = firstJson<{ budget: unknown }>(
        await mcp.callTool('session_receipt', { since })
      );
      // No ceiling applies, so there is no budget to report — the tile is
      // absent for the same reason it is absent on an unconfigured instance.
      expect(exempt.budget).toBeNull();
    } finally {
      await admin().rpc('revoke_provider_credential', {
        p_subject_id: subjectId,
      });
      await clearAllowance(subjectId);
      await mcp.close();
    }
  });
});

test.describe('consumption on a caller-supplied credential stays outside the ceiling', () => {
  test('the counter reports only what the instance credential consumed', async () => {
    const user = await provisionE2EUser('own-key-spend@zm.e2e');
    const subjectId = await entityIdOf(user.id);
    const mcp = await McpTestClient.connect(await passwordGrantToken(user));
    const since = new Date(Date.now() - 3_600_000).toISOString();

    try {
      // The case the exemption does NOT cover: the caller holds no
      // credential now, so a ceiling applies — but part of their ledger ran
      // on a credential of their own, back when they had one. An allowance
      // meters the instance's credential, so those rows are not its
      // consumption and must not eat the ceiling.
      await setAllowance(subjectId, 10_000);
      await recordSpend(subjectId, 1_000);
      await recordSpend(subjectId, 5_000, { ownKey: true });

      const receipt = firstJson<{ budget: { used: number } | null }>(
        await mcp.callTool('session_receipt', { since })
      );
      expect(receipt.budget?.used).toBe(1_000);
    } finally {
      await clearAllowance(subjectId);
      await mcp.close();
    }
  });
});

test.describe('the budget line names when its window turns over', () => {
  test('the receipt carries a turnover date inside the next month', async () => {
    const user = await provisionE2EUser('budget-window@zm.e2e');
    const subjectId = await entityIdOf(user.id);
    const mcp = await McpTestClient.connect(await passwordGrantToken(user));
    const since = new Date(Date.now() - 3_600_000).toISOString();

    try {
      await setAllowance(subjectId, 1_000);
      const receipt = firstJson<{
        budget: { window_ends_at: string | null } | null;
      }>(await mcp.callTool('session_receipt', { since }));
      expect(receipt.budget).not.toBeNull();

      // The window is anchored at the subject's start of use, so for a user
      // provisioned moments ago the first turnover lies about a month out —
      // strictly in the future, and no further than a month plus slack.
      const endsAt = receipt.budget?.window_ends_at;
      expect(endsAt).toBeTruthy();
      const ends = new Date(endsAt as string).getTime();
      expect(ends).toBeGreaterThan(Date.now());
      expect(ends).toBeLessThan(Date.now() + 32 * 24 * 60 * 60 * 1000);
    } finally {
      await clearAllowance(subjectId);
      await mcp.close();
    }
  });
});

test.describe('an exhausted budget pauses generation only', () => {
  test('@smoke reading keeps working while new extraction is paused', async () => {
    const user = await provisionE2EUser(EMAIL);
    const subjectId = await entityIdOf(user.id);
    const mcp = await McpTestClient.connect(await passwordGrantToken(user));

    try {
      // Something to read back later, stored while there is still allowance.
      await clearAllowance(subjectId);
      const stored = await mcp.callTool('remember', {
        content: 'the budget spec stored this before the allowance ran out',
        kind: 'fact',
        scope: 'personal',
      });
      expect(stored.isError ?? false).toBe(false);

      // Now the allowance is used up.
      await setAllowance(subjectId, 1_000);
      await recordSpend(subjectId, 1_000);

      // Generation stops, and says so honestly.
      const ingest = await mcp.callTool('ingest_conversation', {
        transcript_chunk: 'user: we chose ltree for scopes\nagent: noted',
        chunk_hash: 'e2e-budget-paused-0001',
        conversation_id: 'budget-spec-conversation',
        client: 'e2e',
      });
      expect(contentText(ingest)).toContain('budget_exhausted');

      // Everything that only reads is untouched.
      const recalled = await mcp.callTool('recall', {
        query: 'what did the budget spec store',
      });
      expect(recalled.isError ?? false).toBe(false);
      expect(contentText(recalled)).toContain('before the allowance ran out');

      const briefing = await mcp.callTool('build_context', {
        topic: 'what the budget spec stored',
        briefing: true,
      });
      expect(briefing.isError ?? false).toBe(false);

      const exported = await mcp.callTool('export_memories', {});
      expect(exported.isError ?? false).toBe(false);
      expect(contentText(exported)).toContain('before the allowance ran out');

      // The withholding is on the record. This is what makes the mechanism
      // checkable rather than merely claimed: nothing can be held back
      // without leaving an entry saying so.
      const { data: audited } = await admin()
        .from('audit_log')
        .select('command, outcome, payload')
        .eq('command', 'BudgetCheck')
        .eq('actor_id', subjectId)
        .eq('outcome', 'error');
      expect(audited?.length ?? 0).toBeGreaterThan(0);
      expect(
        (audited?.[0] as { payload: { budget: string } }).payload.budget
      ).toBe('extraction');
    } finally {
      await clearAllowance(subjectId);
      await mcp.close();
    }
  });

  test('the paused chunk is still pending, not silently swallowed', async () => {
    const user = await provisionE2EUser(EMAIL);
    const subjectId = await entityIdOf(user.id);
    const mcp = await McpTestClient.connect(await passwordGrantToken(user));
    const chunk = `user: deferred at ${String(Date.now())}\nagent: noted`;
    const chunkHash = `e2e-budget-deferred-${String(Date.now())}`;

    try {
      await setAllowance(subjectId, 1_000);
      await recordSpend(subjectId, 1_000);

      const blocked = await mcp.callTool('ingest_conversation', {
        transcript_chunk: chunk,
        chunk_hash: chunkHash,
        conversation_id: 'budget-spec-deferred',
        client: 'e2e',
      });
      expect(contentText(blocked)).toContain('budget_exhausted');

      // Lifting the allowance is all it takes: the same chunk goes through,
      // which it could not do had the blocked attempt claimed it as ingested.
      await setAllowance(subjectId, null);
      const retried = await mcp.callTool('ingest_conversation', {
        transcript_chunk: chunk,
        chunk_hash: chunkHash,
        conversation_id: 'budget-spec-deferred',
        client: 'e2e',
      });
      expect(retried.isError ?? false).toBe(false);
      expect(
        firstJson<{ duplicate?: boolean }>(retried).duplicate ?? false
      ).toBe(false);
    } finally {
      await clearAllowance(subjectId);
      await mcp.close();
    }
  });
});
