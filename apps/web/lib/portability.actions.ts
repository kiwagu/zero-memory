'use server';

import { revalidatePath } from 'next/cache';

import { createServerSupabaseClient } from './supabase/server';

export type ActionResult = { ok: true } | { ok: false; error: string };

/**
 * A human's decision on a portability proposal:
 *   - approve — the memory IS a portable world fact; the re-scope
 *               (project → the owner's core scope) is applied
 *   - dismiss — not portable after all; terminal, the memory is never
 *               proposed again
 */
export type PortabilityCandidateDecision = 'approve' | 'dismiss';

/**
 * Resolve one portability proposal through the `resolve_portability_candidate`
 * RPC, which runs the ownership check, the status flip, the re-scope (on
 * approve), and the audit_log entry in ONE transaction — the resolution and
 * its audit row can never diverge. Runs as the signed-in owner.
 */
export async function resolvePortabilityCandidate(
  candidateId: string,
  decision: PortabilityCandidateDecision
): Promise<ActionResult> {
  const supabase = await createServerSupabaseClient();

  const { error } = await supabase.rpc('resolve_portability_candidate', {
    p_candidate_id: candidateId,
    p_approve: decision === 'approve',
  });
  if (error) {
    return { ok: false, error: error.message };
  }

  revalidatePath('/portability');
  return { ok: true };
}
