'use server';

import { revalidatePath } from 'next/cache';

import { rememberViaServer } from './mcp';
import { createServerSupabaseClient } from './supabase/server';
import { currentUserEntityId } from './user';

export type ActionResult = { ok: true } | { ok: false; error: string };

/**
 * A human's decision on a reflection candidate:
 *   - approve — the consolidation is right; the distillate is WRITTEN as a
 *               new memory (embedded through the server's `remember`) with a
 *               derived_from link to every source episode; the sources stay
 *               live — ranking-time decay sinks them naturally
 *   - dismiss — not consolidation material; terminal, the episodes are never
 *               proposed again
 *   - snooze  — hide for a while; the detector re-pends it automatically
 */
export type ReflectionCandidateDecision = 'approve' | 'dismiss' | 'snooze';

/** How long a snoozed candidate stays out of the queue. */
const SNOOZE_DAYS = 14;

/**
 * Resolve one reflection candidate. Runs as the signed-in owner: RLS gates
 * the row (owner_id), so a caller can only ever act on their own clusters.
 * Rows are never deleted — the status flip with actor and timestamp IS the
 * audit trail of the decision (mirrors the rules incubator).
 */
export async function resolveReflectionCandidate(
  candidateId: string,
  decision: ReflectionCandidateDecision
): Promise<ActionResult> {
  const supabase = await createServerSupabaseClient();
  const userId = await currentUserEntityId(supabase);
  if (!userId) {
    return { ok: false, error: 'Not signed in.' };
  }
  const now = new Date();

  if (decision === 'approve') {
    return approveCandidate(supabase, candidateId, userId, now);
  }

  const patch =
    decision === 'dismiss'
      ? { status: 'dismissed', resolution: 'dismissed_by_owner' }
      : {
          status: 'snoozed',
          resolution: 'snoozed',
          snoozed_until: new Date(
            now.getTime() + SNOOZE_DAYS * 86_400_000
          ).toISOString(),
        };

  const { data, error } = await supabase
    .from('reflection_candidates')
    .update({
      ...patch,
      resolved_by: userId,
      resolved_at: now.toISOString(),
    })
    .eq('id', candidateId)
    .eq('status', 'pending')
    .select('id');
  if (error) {
    return { ok: false, error: error.message };
  }
  if (!data || data.length === 0) {
    return {
      ok: false,
      error: 'Candidate not found, already resolved, or not permitted.',
    };
  }

  revalidatePath('/reflections');
  return { ok: true };
}

type SupabaseServerClient = Awaited<
  ReturnType<typeof createServerSupabaseClient>
>;

/**
 * Approval writes the distillate into the corpus: store the consolidated
 * memory through the server's `remember` (the only path that embeds it),
 * link it derived_from to every source episode, then mark the row approved
 * with the written memory recorded. The memory effect happens first — a
 * failed status flip after a successful write leaves a re-runnable state,
 * never a half-written memory.
 */
async function approveCandidate(
  supabase: SupabaseServerClient,
  candidateId: string,
  userId: string,
  now: Date
): Promise<ActionResult> {
  const accessToken = (await supabase.auth.getSession()).data.session
    ?.access_token;
  if (!accessToken) {
    return { ok: false, error: 'Not signed in.' };
  }

  const { data: row, error: loadError } = await supabase
    .from('reflection_candidates')
    .select('id, scope, distilled_content, distilled_kind, status')
    .eq('id', candidateId)
    .single();
  if (loadError || !row) {
    return { ok: false, error: 'Candidate not found or not permitted.' };
  }
  if (row.status !== 'pending') {
    return { ok: false, error: 'This candidate was already resolved.' };
  }
  if (!row.distilled_content || !row.distilled_kind) {
    return { ok: false, error: 'This candidate has no distilled draft yet.' };
  }

  const { data: members, error: memberError } = await supabase
    .from('reflection_candidate_members')
    .select('memory_id')
    .eq('candidate_id', candidateId)
    .order('ord', { ascending: true });
  if (memberError || !members || members.length === 0) {
    return { ok: false, error: 'Candidate members are not readable.' };
  }

  let memoryId: string;
  try {
    // reflection_candidates.scope is ltree, generated as `unknown`; it is a
    // string on the wire.
    // Deliberately NOT marked as human-authored: the owner APPROVED this text,
    // they did not write it — `distilled_content` is the distiller's prose,
    // unedited. Approval is not authorship, and rank 2 is for what a person
    // actually wrote.
    memoryId = (
      await rememberViaServer(
        accessToken,
        row.distilled_content,
        row.scope as string,
        row.distilled_kind
      )
    ).id;
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  // Provenance: the distillate is derived from every source episode. The
  // sources are deliberately NOT invalidated — decay demotes them while the
  // fuller, fresher distillate wins ranking on its own.
  for (const member of members) {
    const { error: linkError } = await supabase
      .from('memory_links')
      .upsert(
        { src: memoryId, dst: member.memory_id, type: 'derived_from' },
        { onConflict: 'src,dst,type', ignoreDuplicates: true }
      );
    if (linkError) {
      return { ok: false, error: linkError.message };
    }
  }

  const { data: updated, error: updateError } = await supabase
    .from('reflection_candidates')
    .update({
      status: 'approved',
      resolution: 'approved',
      approved_memory_id: memoryId,
      resolved_by: userId,
      resolved_at: now.toISOString(),
    })
    .eq('id', candidateId)
    .eq('status', 'pending')
    .select('id');
  if (updateError) {
    return { ok: false, error: updateError.message };
  }
  if (!updated || updated.length === 0) {
    return {
      ok: false,
      error: 'Candidate not found, already resolved, or not permitted.',
    };
  }

  revalidatePath('/reflections');
  return { ok: true };
}
