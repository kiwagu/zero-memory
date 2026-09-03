'use server';

import { revalidatePath } from 'next/cache';

import { createServerSupabaseClient } from './supabase/server';
import { currentUserEntityId } from './user';

export type ActionResult = { ok: true } | { ok: false; error: string };

/**
 * A human's decision on a rule candidate:
 *   - promote — the rule earned its always-on place; the card turns into a
 *               copy/download block (the server never writes user files)
 *   - dismiss — not rule material; terminal, never proposed again
 *   - snooze  — hide for a while; the detector re-pends it automatically
 */
export type RuleCandidateDecision = 'promote' | 'dismiss' | 'snooze';

/**
 * Where a promoted rule is addressed: the general (every-session) layer, or
 * one concrete project scope. Chosen at promotion — the boundary is easy to
 * miss, so the UI defaults a project-looking rule to its project.
 */
export interface RuleAddressing {
  targetLayer: 'user' | 'project';
  /** Required for the project layer: the scope the rule binds to. */
  appliesScope?: string;
}

const SCOPE_PATTERN = /^[a-z0-9_]+(\.[a-z0-9_]+)*$/;

/** How long a snoozed candidate stays out of the queue. */
const SNOOZE_DAYS = 14;

/**
 * Resolve one rule candidate. Runs as the signed-in owner: RLS gates the row
 * (owner of the source memory), so a caller can only ever act on their own
 * candidates. Rows are never deleted — the status flip with actor and
 * timestamp IS the audit trail of the decision (mirrors the review queue).
 */
export async function resolveRuleCandidate(
  candidateId: string,
  decision: RuleCandidateDecision,
  addressing?: RuleAddressing
): Promise<ActionResult> {
  const supabase = await createServerSupabaseClient();
  const userId = await currentUserEntityId(supabase);
  if (!userId) {
    return { ok: false, error: 'Not signed in.' };
  }
  if (addressing) {
    if (!['user', 'project'].includes(addressing.targetLayer)) {
      return { ok: false, error: 'Invalid target layer.' };
    }
    if (addressing.targetLayer === 'project') {
      if (
        !addressing.appliesScope ||
        !SCOPE_PATTERN.test(addressing.appliesScope)
      ) {
        return { ok: false, error: 'A project rule needs a valid scope.' };
      }
    }
  }

  const now = new Date();
  const patch =
    decision === 'promote'
      ? {
          status: 'promoted',
          resolution: 'promoted',
          promoted_at: now.toISOString(),
          // The addressing decision made at the promotion moment: general
          // vs one project (with the explicit delivery scope).
          ...(addressing
            ? {
                target_layer: addressing.targetLayer,
                applies_scope:
                  addressing.targetLayer === 'project'
                    ? (addressing.appliesScope ?? null)
                    : null,
              }
            : {}),
        }
      : decision === 'dismiss'
        ? { status: 'dismissed', resolution: 'dismissed_by_owner' }
        : {
            status: 'snoozed',
            resolution: 'snoozed',
            snoozed_until: new Date(
              now.getTime() + SNOOZE_DAYS * 86_400_000
            ).toISOString(),
          };

  const { data, error } = await supabase
    .from('rule_candidates')
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
      error: 'Rule candidate not found, already resolved, or not permitted.',
    };
  }

  revalidatePath('/rules');
  return { ok: true };
}

/**
 * Promote one of the owner's OWN memories straight into a promoted rule from
 * the /memory dashboard. The web tier is LLM-free and cannot INSERT
 * rule_candidates under RLS, so this goes through the SECURITY DEFINER
 * `promote_memory_to_rule` RPC (ownership gated by owns_memory server-side).
 *
 * Addressing mirrors the /rules promote default: a project-scoped memory is
 * addressed to its own project layer; a personal-scope memory becomes a
 * General (user-layer) rule. The rule draft is the memory's own text — the
 * owner can refine or revoke it from /rules.
 */
export type PromoteResult =
  { ok: true } | { ok: false; error: string; dismissed?: boolean };

export async function promoteMemoryToRule(
  memoryId: string,
  force = false
): Promise<PromoteResult> {
  const supabase = await createServerSupabaseClient();
  const userId = await currentUserEntityId(supabase);
  if (!userId) {
    return { ok: false, error: 'Not signed in.' };
  }

  // Read the anchor scope to pick the default addressing. RLS already scopes
  // this to a memory the caller can see; the RPC re-checks ownership.
  const { data: memory, error: readError } = await supabase
    .from('memories')
    .select('scope')
    .eq('id', memoryId)
    .maybeSingle();
  if (readError) {
    return { ok: false, error: readError.message };
  }
  if (!memory) {
    return { ok: false, error: 'Memory not found or not permitted.' };
  }

  const scope = String(memory.scope);
  const isPersonal = scope === 'user' || scope.startsWith('user.');
  const appliesScope = isPersonal ? null : scope;

  const { error } = await supabase.rpc('promote_memory_to_rule', {
    p_memory_id: memoryId,
    p_applies_scope: appliesScope,
    p_force: force,
  });
  if (error) {
    // The RPC refuses to revive a deliberately dismissed candidacy without an
    // explicit override; flag it so the UI can offer "promote anyway".
    const dismissed = error.message.includes('dismissed as a rule');
    return { ok: false, error: error.message, dismissed };
  }

  revalidatePath('/rules');
  revalidatePath(`/memory/${memoryId}`);
  return { ok: true };
}

/**
 * Toggle the delivery pin of a PROMOTED rule (either layer). A pinned rule is
 * exempt from the delivery cap and the delivery TTL and leads the briefing's
 * rules[] — the owner's guarantee that it reaches the session at all, which
 * matters once there are more rules than any channel can carry. Owner-only
 * via RLS; the status guard keeps the flag meaningful (a pending draft is not
 * delivered anywhere yet).
 */
export async function setRulePinned(
  candidateId: string,
  pinned: boolean
): Promise<ActionResult> {
  const supabase = await createServerSupabaseClient();
  const userId = await currentUserEntityId(supabase);
  if (!userId) {
    return { ok: false, error: 'Not signed in.' };
  }

  const { data, error } = await supabase
    .from('rule_candidates')
    .update({ pinned })
    .eq('id', candidateId)
    .eq('status', 'promoted')
    .select('id');
  if (error) {
    return { ok: false, error: error.message };
  }
  if (!data || data.length === 0) {
    return {
      ok: false,
      error: 'Rule not found, not an active rule, or not permitted.',
    };
  }

  revalidatePath('/rules');
  return { ok: true };
}

/** A revoke reason cannot be empty and is bounded (it is owner free-text). */
const REVOKE_REASON_MAX = 500;

/**
 * Revoke a PROMOTED rule the owner pulled back out of their always-on layer,
 * recording why. Runs as the signed-in owner (RLS gates the row by memory
 * ownership). The row stays terminal — the incubator will not re-propose a
 * rule the owner just decided against — and keeps the reason for the audit
 * trail. Only a currently-promoted candidate can be revoked.
 */
export async function revokeRuleCandidate(
  candidateId: string,
  reason: string
): Promise<ActionResult> {
  const trimmed = reason.trim();
  if (!trimmed) {
    return { ok: false, error: 'A revoke reason is required.' };
  }

  const supabase = await createServerSupabaseClient();
  const userId = await currentUserEntityId(supabase);
  if (!userId) {
    return { ok: false, error: 'Not signed in.' };
  }

  const now = new Date();
  const { data, error } = await supabase
    .from('rule_candidates')
    .update({
      status: 'revoked',
      resolution: 'revoked',
      revoke_reason: trimmed.slice(0, REVOKE_REASON_MAX),
      revoked_at: now.toISOString(),
      resolved_by: userId,
      resolved_at: now.toISOString(),
    })
    .eq('id', candidateId)
    .eq('status', 'promoted')
    .select('id');
  if (error) {
    return { ok: false, error: error.message };
  }
  if (!data || data.length === 0) {
    return {
      ok: false,
      error: 'Rule not found, not currently active, or not permitted.',
    };
  }

  revalidatePath('/rules');
  return { ok: true };
}

/**
 * Hard-delete a DISMISSED candidate (the only deletable status — RLS
 * enforces it). Clearing a dismissal also frees the memory for a future
 * candidacy, since candidacy is unique per memory.
 */
export async function deleteRuleCandidate(
  candidateId: string
): Promise<ActionResult> {
  const supabase = await createServerSupabaseClient();
  const userId = await currentUserEntityId(supabase);
  if (!userId) {
    return { ok: false, error: 'Not signed in.' };
  }

  const { data, error } = await supabase
    .from('rule_candidates')
    .delete()
    .eq('id', candidateId)
    .eq('status', 'dismissed')
    .select('id');
  if (error) {
    return { ok: false, error: error.message };
  }
  if (!data || data.length === 0) {
    return {
      ok: false,
      error: 'Rule candidate not found, not dismissed, or not permitted.',
    };
  }

  revalidatePath('/rules');
  return { ok: true };
}
