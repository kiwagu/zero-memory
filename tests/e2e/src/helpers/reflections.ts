/**
 * Seeds a ready-to-review reflection candidate for a user through the
 * service-role client: three episode memories telling one story, the
 * candidate row with a distilled draft, and the membership rows — the state
 * the detector+distiller would produce. Every call creates a fresh cluster
 * (unique marker), so retries and parallel workers never collide on the
 * members' unique(memory_id).
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import { e2eEnv } from './env.js';
import type { E2EUser } from './users.js';

export interface SeededReflection {
  candidateId: string;
  /** Distilled draft text (unique per seed via the marker). */
  draft: string;
  /** Unique token present in the draft and every episode. */
  marker: string;
  episodeIds: string[];
  ownerId: string;
}

const adminClient = (): SupabaseClient =>
  createClient(e2eEnv.supabaseUrl, e2eEnv.supabaseServiceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

/** Overridable strings so the demo seed can drop the fixture markers from
 * content that lands in published screenshots; specs keep the defaults. */
export interface ReflectionFixture {
  episodes: [string, string, string];
  draft: string;
  rationale: string;
}

export const seedReflectionCandidate = async (
  user: E2EUser,
  fixture?: ReflectionFixture
): Promise<SeededReflection> => {
  const client = adminClient();

  const { data: profile, error: profileError } = await client
    .from('profiles')
    .select('id')
    .eq('user_id', user.id)
    .single();
  if (profileError || !profile) {
    throw new Error(
      `reflection seed: profile lookup failed: ${profileError?.message}`
    );
  }
  const ownerId = (profile as { id: string }).id;
  const scope = `user.${ownerId.replace('.', '_')}`;
  const marker = `probe-${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;

  const episodes = fixture?.episodes ?? [
    `Reflection fixture (${marker}): session log — started moving the export job to the batch runner, retries not wired yet.`,
    `Reflection fixture (${marker}): checkpoint — batch runner handles retries with a dead-letter list after 3 attempts.`,
    `Reflection fixture (${marker}): wrap-up — the export job runs only on the batch runner, dead-letter after 3 retries.`,
  ];
  const { data: inserted, error: memoryError } = await client
    .from('memories')
    .insert(
      episodes.map((content) => ({
        content,
        kind: 'episode',
        scope,
        owner_id: ownerId,
      }))
    )
    .select('id');
  if (memoryError || !inserted || inserted.length !== episodes.length) {
    throw new Error(
      `reflection seed: episode insert failed: ${memoryError?.message}`
    );
  }
  const episodeIds = (inserted as Array<{ id: string }>).map((row) => row.id);

  const draft =
    fixture?.draft ??
    `Reflection fixture (${marker}): the export job now runs exclusively on ` +
      'the batch runner with retries and a dead-letter list after 3 attempts.';
  const { data: candidate, error: candidateError } = await client
    .from('reflection_candidates')
    .insert({
      owner_id: ownerId,
      scope,
      distilled_content: draft,
      distilled_kind: 'fact',
      judge_confidence: 0.9,
      judge_rationale:
        fixture?.rationale ??
        'E2E fixture: one evolving story with a final state.',
      judge_model: 'e2e-fixture',
    })
    .select('id')
    .single();
  if (candidateError || !candidate) {
    throw new Error(
      `reflection seed: candidate insert failed: ${candidateError?.message}`
    );
  }
  const candidateId = (candidate as { id: string }).id;

  const { error: memberError } = await client
    .from('reflection_candidate_members')
    .insert(
      episodeIds.map((memoryId, index) => ({
        candidate_id: candidateId,
        memory_id: memoryId,
        ord: index,
      }))
    );
  if (memberError) {
    throw new Error(
      `reflection seed: member insert failed: ${memberError.message}`
    );
  }

  return { candidateId, draft, marker, episodeIds, ownerId };
};

/** Reads the candidate row back (status + approved memory), service-role. */
export const readReflectionCandidate = async (
  candidateId: string
): Promise<{ status: string; approvedMemoryId: string | null }> => {
  const { data, error } = await adminClient()
    .from('reflection_candidates')
    .select('status, approved_memory_id')
    .eq('id', candidateId)
    .single();
  if (error || !data) {
    throw new Error(`reflection read: ${error?.message}`);
  }
  return {
    status: (data as { status: string }).status,
    approvedMemoryId: (data as { approved_memory_id: string | null })
      .approved_memory_id,
  };
};

/** Counts derived_from links from a memory to the given sources. */
export const countDerivedFromLinks = async (
  srcMemoryId: string,
  dstMemoryIds: string[]
): Promise<number> => {
  const { data, error } = await adminClient()
    .from('memory_links')
    .select('dst')
    .eq('src', srcMemoryId)
    .eq('type', 'derived_from')
    .in('dst', dstMemoryIds);
  if (error) {
    throw new Error(`reflection links read: ${error.message}`);
  }
  return data?.length ?? 0;
};
