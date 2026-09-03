/**
 * Seeds rules-incubator fixtures for a user, straight through the
 * service-role client (candidate rows are inserted by the server-side
 * detector in production; end users only resolve). Idempotent and
 * retry-safe: re-seeding flips the candidate back to pending, so each spec
 * can guarantee a fresh queue regardless of order or retries.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import { e2eEnv } from './env.js';
import type { E2EUser } from './users.js';

export interface SeededRuleCandidate {
  candidateId: string;
  memoryId: string;
  ruleText: string;
  memoryContent: string;
}

// Dedicated content (not part of FIXTURE_MEMORIES) so resolving it never
// disturbs the feed fixtures other specs assert on.
const MEMORY_CONTENT =
  'E2E incubator fixture: commit messages are single-line `type(scope): subject`.';
const RULE_TEXT =
  'Always write commit messages as a single line: `type(scope): subject`.';

/** Speculative sibling scope carried by the seeded recommendation set. */
export const SUGGESTED_SIBLING_SCOPE = 'proj.e2e_sibling';

const adminClient = (): SupabaseClient =>
  createClient(e2eEnv.supabaseUrl, e2eEnv.supabaseServiceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

const ownerProfileId = async (
  client: SupabaseClient,
  user: E2EUser
): Promise<string> => {
  const { data: profile, error } = await client
    .from('profiles')
    .select('id')
    .eq('user_id', user.id)
    .single();
  if (error || !profile) {
    throw new Error(`rules seed: profile lookup failed: ${error?.message}`);
  }
  return (profile as { id: string }).id;
};

/** Insert-or-reuse an active memory owned by the user. */
const seedMemory = async (
  client: SupabaseClient,
  ownerId: string,
  content: string,
  kind = 'convention'
): Promise<string> => {
  const scope = `user.${ownerId.replace('.', '_')}`;
  const { data: existing } = await client
    .from('memories')
    .select('id')
    .eq('owner_id', ownerId)
    .eq('content', content)
    .is('invalidated_at', null)
    .maybeSingle();
  if (existing) {
    return (existing as { id: string }).id;
  }
  const { data: inserted, error } = await client
    .from('memories')
    .insert({ content, kind, scope, owner_id: ownerId })
    .select('id')
    .single();
  if (error) {
    throw new Error(`rules seed: insert memory failed: ${error.message}`);
  }
  return (inserted as { id: string }).id;
};

/** A spec-owned candidate fixture; defaults keep the shared incubator row. */
export interface RuleCandidateFixture {
  content: string;
  ruleText: string;
  /**
   * Judge rationale shown verbatim in the queue UI. Optional so the demo
   * seed can pass presentable prose while specs keep the fixture marker.
   */
  rationale?: string;
  /** Speculative suggested scope; specs assert on the exported default. */
  siblingScope?: string;
}

/** Seed one pending, already-distilled rule candidate for the user. */
export const seedRuleCandidate = async (
  user: E2EUser,
  fixture: RuleCandidateFixture = {
    content: MEMORY_CONTENT,
    ruleText: RULE_TEXT,
  }
): Promise<SeededRuleCandidate> => {
  const client = adminClient();
  const ownerId = await ownerProfileId(client, user);
  const memoryId = await seedMemory(client, ownerId, fixture.content);
  const originScope = `user.${ownerId.replace('.', '_')}`;

  const now = Date.now();
  const { data: candidate, error } = await client
    .from('rule_candidates')
    .upsert(
      {
        memory_id: memoryId,
        useful_sessions: 4,
        window_days: 30,
        first_used_at: new Date(now - 20 * 86_400_000).toISOString(),
        last_used_at: new Date(now - 86_400_000).toISOString(),
        session_keys: ['e2e-conv-1', 'e2e-conv-2', 'e2e-conv-3', 'e2e-conv-4'],
        rule_text: fixture.ruleText,
        target_layer: 'user',
        judge_confidence: 0.92,
        judge_rationale: fixture.rationale ?? 'E2E seeded distillation.',
        judge_model: 'e2e-fixture',
        // Ranked recommendation: deterministic origin + one speculative guess.
        suggested_scopes: [
          { scope: originScope, score: 1, source: 'origin' },
          {
            scope: fixture.siblingScope ?? SUGGESTED_SIBLING_SCOPE,
            score: 0.7,
            source: 'llm',
          },
        ],
        status: 'pending',
        resolution: null,
        resolved_by: null,
        resolved_at: null,
        snoozed_until: null,
        promoted_at: null,
      },
      { onConflict: 'memory_id' }
    )
    .select('id')
    .single();
  if (error || !candidate) {
    throw new Error(`rules seed: enqueue failed: ${error?.message}`);
  }

  return {
    candidateId: (candidate as { id: string }).id,
    memoryId,
    ruleText: fixture.ruleText,
    memoryContent: fixture.content,
  };
};

/** Insert-or-reuse an active memory owned by the user (spec-owned content). */
export const seedOwnedMemory = async (
  user: E2EUser,
  content: string,
  kind = 'convention'
): Promise<string> => {
  const client = adminClient();
  const ownerId = await ownerProfileId(client, user);
  return seedMemory(client, ownerId, content, kind);
};

/** Seed a candidate the owner already dismissed (for the promote-anyway arm). */
export const seedDismissedRuleCandidate = async (
  user: E2EUser,
  fixture?: RuleCandidateFixture
): Promise<SeededRuleCandidate> => {
  const seeded = await seedRuleCandidate(user, fixture);
  const client = adminClient();
  const { error } = await client
    .from('rule_candidates')
    .update({
      status: 'dismissed',
      resolution: 'dismissed',
      resolved_at: new Date().toISOString(),
      promoted_at: null,
    })
    .eq('id', seeded.candidateId);
  if (error) {
    throw new Error(`rules seed: dismiss failed: ${error.message}`);
  }
  return seeded;
};

/** Seed a candidate already in the promoted state (for the revoke flow). */
export const seedPromotedRuleCandidate = async (
  user: E2EUser
): Promise<SeededRuleCandidate> => {
  const seeded = await seedRuleCandidate(user);
  const client = adminClient();
  const { error } = await client
    .from('rule_candidates')
    .update({
      status: 'promoted',
      resolution: 'promoted',
      promoted_at: new Date().toISOString(),
    })
    .eq('id', seeded.candidateId);
  if (error) {
    throw new Error(`rules seed: promote failed: ${error.message}`);
  }
  return seeded;
};

/**
 * Seed the raw detection signal instead of a finished candidate: an owned
 * memory plus recall_used(useful=true) events across N distinct sessions —
 * fuel for asserting the `find_rule_candidates` rollup itself.
 */
export const seedRecallUsedSignal = async (
  user: E2EUser,
  content: string,
  sessions: number,
  kind = 'convention'
): Promise<string> => {
  const client = adminClient();
  const ownerId = await ownerProfileId(client, user);
  const memoryId = await seedMemory(client, ownerId, content, kind);

  for (let index = 0; index < sessions; index += 1) {
    const { error } = await client.from('usage_events').insert({
      user_id: ownerId,
      event_type: 'recall_used',
      quantity: 1,
      unit: 'count',
      metadata: {
        mem_id: memoryId,
        source: 'judge',
        useful: true,
        conversation_id: `e2e-conv-${content.length}-${index}`,
      },
    });
    if (error) {
      throw new Error(`rules seed: usage event failed: ${error.message}`);
    }
  }
  return memoryId;
};

/** Direct service-role call of the detection rollup (integration layer). */
export const findRuleCandidatesRollup = async (
  user: E2EUser
): Promise<Array<{ memory_id: string; useful_sessions: number }>> => {
  const client = adminClient();
  const ownerId = await ownerProfileId(client, user);
  const { data, error } = await client.rpc('find_rule_candidates', {
    p_owner: ownerId,
    p_window_days: 30,
    p_min_sessions: 3,
    p_stability_days: 7,
  });
  if (error) {
    throw new Error(`rules seed: rollup failed: ${error.message}`);
  }
  return (data ?? []) as Array<{ memory_id: string; useful_sessions: number }>;
};
