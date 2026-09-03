/**
 * Seeds value-dashboard fuel for a user through the service-role client: one
 * agent-captured memory plus usage_events (recall calls that surface it, and a
 * hit + miss briefing). usage_events is deny-all and has no delete grant,
 * so this is insert-only and append-only — specs assert presence
 * and content, never exact counts, so retries stay green.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import { e2eEnv } from './env.js';
import type { E2EUser } from './users.js';

export interface SeededInsights {
  /** The seeded memory's id (surfaced in the caller's top facts). */
  memoryId: string;
  /** Its content — unique per user, so specs can assert scope isolation. */
  content: string;
  /** The owner's usr_ entity id (for follow-up event seeds). */
  ownerId: string;
}

const adminClient = (): SupabaseClient =>
  createClient(e2eEnv.supabaseUrl, e2eEnv.supabaseServiceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

/** Overridable visible strings so the demo seed can present real-looking
 * data in published screenshots; specs assert on the defaults. */
export interface InsightsFixture {
  topFact?: string;
  emptyQuery?: string;
  errorQuery?: string;
  agentName?: string;
}

export const seedInsightsUsage = async (
  user: E2EUser,
  fixture: InsightsFixture = {}
): Promise<SeededInsights> => {
  const client = adminClient();

  const { data: profile, error: profileError } = await client
    .from('profiles')
    .select('id')
    .eq('user_id', user.id)
    .single();
  if (profileError || !profile) {
    throw new Error(
      `insights seed: profile lookup failed: ${profileError?.message}`
    );
  }
  const ownerId = (profile as { id: string }).id;
  const scope = `user.${ownerId.replace('.', '_')}`;
  // Unique per user so a cross-user spec can assert B never sees A's content.
  const content =
    fixture.topFact ??
    `E2E insights fixture (${ownerId}): value dashboard top fact.`;

  const { data: existing } = await client
    .from('memories')
    .select('id')
    .eq('owner_id', ownerId)
    .eq('content', content)
    .is('invalidated_at', null)
    .maybeSingle();

  let memoryId: string;
  if (existing) {
    memoryId = (existing as { id: string }).id;
  } else {
    const { data: inserted, error } = await client
      .from('memories')
      .insert({ content, kind: 'decision', scope, owner_id: ownerId })
      .select('id')
      .single();
    if (error) {
      throw new Error(`insights seed: insert memory failed: ${error.message}`);
    }
    memoryId = (inserted as { id: string }).id;
  }

  // These rows are inserted straight into the table, so nothing fills the
  // columns the SERVER would fill on a real call — the agent name from the
  // client handshake and the request id from the ambient request context.
  // Both are set by hand here: a fixture row missing them renders in the
  // activity feed as an actor-less row with no query line and no correlation
  // id, which reads as a product defect rather than as seeded data.
  const { error: usageError } = await client.from('usage_events').insert([
    {
      user_id: ownerId,
      event_type: 'mcp_tool_call',
      quantity: 1,
      unit: 'count',
      agent_name: fixture.agentName ?? 'e2e-agent',
      request_id: 'req_e2ehitrecall00.01e2eactivity',
      metadata: {
        tool: 'recall',
        returned: 1,
        returned_ids: [memoryId],
        query: 'what does the e2e fixture decide about the value dashboard?',
      },
    },
    {
      user_id: ownerId,
      event_type: 'mcp_tool_call',
      quantity: 1,
      unit: 'count',
      agent_name: fixture.agentName ?? 'e2e-agent',
      request_id: 'req_e2ehitcontext0.01e2eactivity',
      metadata: {
        tool: 'build_context',
        returned: 1,
        returned_ids: [memoryId],
        query: 'e2e fixture value dashboard',
      },
    },
    // An empty recall: fuel for the empty-recall rate tile and the activity
    // feed's "empty" outcome badge/filter. Carries the query (the metering
    // layer always records it) — the feed reads it off the row header — and
    // the request id that makes the row worth expanding, as real rows do.
    {
      user_id: ownerId,
      event_type: 'mcp_tool_call',
      quantity: 1,
      unit: 'count',
      // The correlation id is a COLUMN, not a metadata key — the feed RPC
      // reads `usage_events.request_id`.
      request_id: 'req_e2eempty0000000.01e2eactivity',
      metadata: {
        tool: 'recall',
        returned: 0,
        returned_ids: [],
        query: fixture.emptyQuery ?? 'what is the quokka retry budget?',
      },
    },
    // A failed recall attributed to a named agent: fuel for the error badge,
    // the errors filter, and agent attribution in the feed. Carries the
    // query and request id too — what was asked, and the correlation id the
    // expanded row hands over for debugging.
    {
      user_id: ownerId,
      event_type: 'mcp_tool_call',
      quantity: 1,
      unit: 'count',
      agent_name: fixture.agentName ?? 'e2e-agent',
      request_id: 'req_e2eerror0000000.01e2eactivity',
      metadata: {
        tool: 'recall',
        error: true,
        query: fixture.errorQuery ?? 'which quokka export failed?',
      },
    },
    {
      user_id: ownerId,
      event_type: 'session_briefing',
      quantity: 300,
      unit: 'tokens',
      metadata: { topic_len: 6, returned: 1, empty: false },
    },
    {
      user_id: ownerId,
      event_type: 'session_briefing',
      quantity: 0,
      unit: 'tokens',
      metadata: { topic_len: 4, returned: 0, empty: true },
    },
  ]);
  if (usageError) {
    throw new Error(
      `insights seed: insert usage failed: ${usageError.message}`
    );
  }

  return { memoryId, content, ownerId };
};

/**
 * Seeds one judge relevance verdict for a memory — what the (optional)
 * watcher judge would emit after scoring a session. Fuel for the context-
 * precision tile: a user WITHOUT any such verdict must keep seeing the
 * "connect a watcher" placeholder, so specs seed this ONLY for user B.
 */
/**
 * Seeds one completed ROI-benchmark run: a probe over the given memory plus
 * its judged result row. Only ever seeded for user B — user A's specs assert
 * the "run benchmark_memory" placeholder deterministically.
 */
export const seedRoiRun = async (
  ownerId: string,
  memoryId: string
): Promise<void> => {
  const client = adminClient();
  const { data: probe, error: probeError } = await client
    .from('roi_probes')
    .insert({
      owner_id: ownerId,
      question: `E2E: what does project memory say about fixture ${memoryId}?`,
      source_memory_id: memoryId,
    })
    .select('id')
    .single();
  if (probeError || !probe) {
    throw new Error(`roi seed: insert probe failed: ${probeError?.message}`);
  }
  // A structurally valid rrn_ id (Crockford body + timestamp block).
  const runId = `rrn_0123456789abcdef.${String(Date.now()).slice(-10)}`;
  const { error: resultError } = await client.from('roi_results').insert({
    run_id: runId,
    probe_id: (probe as { id: string }).id,
    owner_id: ownerId,
    with_memory: true,
    without_memory: false,
    confidence: 1,
    model: 'e2e-fixture',
  });
  if (resultError) {
    throw new Error(`roi seed: insert result failed: ${resultError.message}`);
  }
};

/**
 * Seeds backdated briefing usage so the "this week vs last" digest has two full
 * weeks to compare: one briefing ~10 days ago (last week) and two ~3 days ago
 * (this week), producing a positive saved-tokens delta. occurred_at is set
 * explicitly (insert-only, append-only), so the daily series spans the fortnight
 * and the digest section renders. Returns the owner id for follow-up seeds.
 */
export const seedWeeklyDigestUsage = async (user: E2EUser): Promise<string> => {
  const client = adminClient();
  const { data: profile, error: profileError } = await client
    .from('profiles')
    .select('id')
    .eq('user_id', user.id)
    .single();
  if (profileError || !profile) {
    throw new Error(
      `digest seed: profile lookup failed: ${profileError?.message}`
    );
  }
  const ownerId = (profile as { id: string }).id;
  const daysAgo = (n: number): string =>
    new Date(Date.now() - n * 86_400_000).toISOString();

  const { error } = await client.from('usage_events').insert([
    // Last week: one briefing carrying context.
    {
      user_id: ownerId,
      event_type: 'session_briefing',
      quantity: 300,
      unit: 'tokens',
      occurred_at: daysAgo(10),
      metadata: { topic_len: 6, returned: 1, empty: false },
    },
    // This week: two briefings carrying context — a positive weekly delta.
    {
      user_id: ownerId,
      event_type: 'session_briefing',
      quantity: 300,
      unit: 'tokens',
      occurred_at: daysAgo(3),
      metadata: { topic_len: 6, returned: 1, empty: false },
    },
    {
      user_id: ownerId,
      event_type: 'session_briefing',
      quantity: 300,
      unit: 'tokens',
      occurred_at: daysAgo(2),
      metadata: { topic_len: 6, returned: 1, empty: false },
    },
  ]);
  if (error) {
    throw new Error(`digest seed: insert usage failed: ${error.message}`);
  }
  return ownerId;
};

export const seedRelevanceVerdict = async (
  ownerId: string,
  memoryId: string
): Promise<void> => {
  const client = adminClient();
  const { error } = await client.from('usage_events').insert({
    user_id: ownerId,
    event_type: 'recall_used',
    quantity: 1,
    unit: 'count',
    metadata: {
      mem_id: memoryId,
      source: 'judge',
      useful: false,
      relevant: true,
      confidence: 0.9,
    },
  });
  if (error) {
    throw new Error(`insights seed: insert relevance failed: ${error.message}`);
  }
};

/**
 * Seeds ONE activity row carrying more facts than a row shows at once, so a
 * spec can exercise the "+N more" disclosure. The row is deliberately fatter
 * than {@link seedInsightsUsage}'s: the reveal only appears once the fetched
 * facts outnumber the visible portion.
 */
export const seedActivityRowWithManyFacts = async (
  user: E2EUser,
  count = 12
): Promise<{ requestId: string; memoryIds: string[] }> => {
  const client = adminClient();

  const { data: profile, error: profileError } = await client
    .from('profiles')
    .select('id')
    .eq('user_id', user.id)
    .single();
  if (profileError || !profile) {
    throw new Error(
      `activity seed: profile lookup failed: ${profileError?.message}`
    );
  }
  const ownerId = (profile as { id: string }).id;
  const scope = `user.${ownerId.replace('.', '_')}`;
  const requestId = 'req_e2emanyfacts0.01e2eactivity';

  const rows = Array.from({ length: count }, (_, index) => ({
    content: `E2E activity fixture (${ownerId}): surfaced fact number ${index + 1}.`,
    kind: 'fact' as const,
    scope,
    owner_id: ownerId,
  }));
  const { data: inserted, error } = await client
    .from('memories')
    .insert(rows)
    .select('id');
  if (error || !inserted) {
    throw new Error(`activity seed: insert memories failed: ${error?.message}`);
  }
  const memoryIds = (inserted as Array<{ id: string }>).map(({ id }) => id);

  const { error: usageError } = await client.from('usage_events').insert({
    user_id: ownerId,
    event_type: 'mcp_tool_call',
    quantity: 1,
    unit: 'count',
    agent_name: 'e2e-agent',
    request_id: requestId,
    metadata: {
      tool: 'recall',
      returned: memoryIds.length,
      returned_ids: memoryIds,
      query: 'e2e fixture: a recall that surfaced more facts than a row shows',
    },
  });
  if (usageError) {
    throw new Error(
      `activity seed: insert usage failed: ${usageError.message}`
    );
  }

  return { requestId, memoryIds };
};
