/**
 * Seeds a pending memory-hygiene conflict for a user, straight through the
 * service-role client (the review queue is deny-all to end users). Idempotent
 * and retry-safe: re-seeding the same pair flips it back to pending, so each
 * spec can guarantee a fresh conflict regardless of order or retries.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import { e2eEnv } from './env.js';
import type { E2EUser } from './users.js';

export interface SeededReviewConflict {
  queueId: string;
  contentA: string;
  contentB: string;
}

// Dedicated content (not part of FIXTURE_MEMORIES) so resolving it never
// disturbs the feed fixtures other specs assert on.
const CONTENT_A = 'E2E hygiene fixture: production deploys run on Fridays.';
const CONTENT_B =
  'E2E hygiene fixture: production deploys never run on Fridays.';

const adminClient = (): SupabaseClient =>
  createClient(e2eEnv.supabaseUrl, e2eEnv.supabaseServiceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

export const seedReviewConflict = async (
  user: E2EUser
): Promise<SeededReviewConflict> => {
  const client = adminClient();

  const { data: profile, error: profileError } = await client
    .from('profiles')
    .select('id')
    .eq('user_id', user.id)
    .single();
  if (profileError || !profile) {
    throw new Error(
      `review seed: profile lookup failed: ${profileError?.message}`
    );
  }
  const ownerId = (profile as { id: string }).id;
  const scope = `user.${ownerId.replace('.', '_')}`;

  const ids: string[] = [];
  for (const content of [CONTENT_A, CONTENT_B]) {
    const { data: existing } = await client
      .from('memories')
      .select('id')
      .eq('owner_id', ownerId)
      .eq('content', content)
      .is('invalidated_at', null)
      .maybeSingle();
    if (existing) {
      ids.push((existing as { id: string }).id);
      continue;
    }
    const { data: inserted, error } = await client
      .from('memories')
      .insert({ content, kind: 'decision', scope, owner_id: ownerId })
      .select('id')
      .single();
    if (error) {
      throw new Error(`review seed: insert memory failed: ${error.message}`);
    }
    ids.push((inserted as { id: string }).id);
  }

  const [memoryA, memoryB] = [...ids].sort();
  const { data: queued, error: queueError } = await client
    .from('memory_review_queue')
    .upsert(
      {
        memory_a: memoryA,
        memory_b: memoryB,
        verdict: 'contradiction',
        confidence: 0.95,
        rationale: 'E2E seeded contradiction.',
        status: 'pending',
        resolution: null,
        resolved_by: null,
        resolved_at: null,
      },
      { onConflict: 'memory_a,memory_b' }
    )
    .select('id')
    .single();
  if (queueError || !queued) {
    throw new Error(`review seed: enqueue failed: ${queueError?.message}`);
  }

  return {
    queueId: (queued as { id: string }).id,
    contentA: CONTENT_A,
    contentB: CONTENT_B,
  };
};

/**
 * Provenance of one of a user's memories, by its exact content — how a spec
 * checks WHO a write was recorded as coming from. Service-role, because the
 * question is about the stored row rather than about what the owner may read.
 */
export const memoryProvenance = async (
  user: E2EUser,
  content: string
): Promise<{ authorKind: string; agentName: string | null }> => {
  const client = adminClient();
  const { data: profile } = await client
    .from('profiles')
    .select('id')
    .eq('user_id', user.id)
    .single();
  if (!profile) {
    throw new Error('review helper: profile lookup failed');
  }
  const { data, error } = await client
    .from('memories')
    .select('author_kind, agent_name')
    .eq('owner_id', (profile as { id: string }).id)
    .eq('content', content)
    .is('invalidated_at', null)
    .single();
  if (error || !data) {
    throw new Error(`review helper: memory not found: ${error?.message}`);
  }
  const row = data as { author_kind: string; agent_name: string | null };
  return { authorKind: row.author_kind, agentName: row.agent_name };
};
