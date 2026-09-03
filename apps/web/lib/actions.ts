'use server';

import { revalidatePath } from 'next/cache';

import { createServerSupabaseClient } from './supabase/server';
import { currentUserEntityId } from './user';

export type ActionResult = { ok: true } | { ok: false; error: string };

const SCOPE_PATTERN = /^[a-z0-9_]+(\.[a-z0-9_]+)*$/;

/**
 * Share a memory into a scope. Mirrors the backend flow: probe
 * `can_write_scope` first (fail-closed — any error means "no"), then flip
 * visibility/scope together with the share provenance. RLS is the final
 * enforcement boundary either way.
 */
export async function shareMemory(
  memoryId: string,
  scope: string
): Promise<ActionResult> {
  if (!SCOPE_PATTERN.test(scope)) {
    return { ok: false, error: `Invalid scope path: "${scope}".` };
  }

  const supabase = await createServerSupabaseClient();
  const userId = await currentUserEntityId(supabase);
  if (!userId) {
    return { ok: false, error: 'Not signed in.' };
  }

  const probe = await supabase.rpc('can_write_scope', { p_scope: scope });
  if (probe.error || probe.data !== true) {
    return {
      ok: false,
      error: `No write access to scope "${scope}".`,
    };
  }

  const { data, error } = await supabase
    .from('memories')
    .update({
      scope,
      visibility: 'shared',
      shared_at: new Date().toISOString(),
      shared_by: userId,
    })
    .eq('id', memoryId)
    .select('id');
  if (error) {
    return { ok: false, error: error.message };
  }
  if (!data || data.length === 0) {
    return { ok: false, error: 'Memory not found or not permitted.' };
  }

  revalidatePath('/memories');
  revalidatePath(`/memory/${memoryId}`);
  return { ok: true };
}

/** Soft-invalidate a memory (ADD-only store: forget = invalidate, owner only). */
export async function forgetMemory(memoryId: string): Promise<ActionResult> {
  const supabase = await createServerSupabaseClient();
  const userId = await currentUserEntityId(supabase);
  if (!userId) {
    return { ok: false, error: 'Not signed in.' };
  }

  const { data, error } = await supabase
    .from('memories')
    .update({
      invalidated_at: new Date().toISOString(),
      invalidated_by: userId,
    })
    .eq('id', memoryId)
    .eq('owner_id', userId)
    .is('invalidated_at', null)
    .select('id');
  if (error) {
    return { ok: false, error: error.message };
  }
  if (!data || data.length === 0) {
    return {
      ok: false,
      error: 'Memory not found, already invalidated, or not owned by you.',
    };
  }

  revalidatePath('/memories');
  revalidatePath(`/memory/${memoryId}`);
  return { ok: true };
}

/** Create a shared scope (caller becomes its first admin). */
export async function createScope(scope: string): Promise<ActionResult> {
  if (!SCOPE_PATTERN.test(scope)) {
    return { ok: false, error: `Invalid scope path: "${scope}".` };
  }

  const supabase = await createServerSupabaseClient();
  const { error } = await supabase.rpc('create_scope', { p_scope: scope });
  if (error) {
    return { ok: false, error: error.message };
  }

  revalidatePath('/scopes');
  return { ok: true };
}

/**
 * Grant (or re-grade) a membership by email. `invite_scope_member` resolves the
 * address and records the grant in one step, so the typed address is stored
 * alongside it — that is what lets the member list name a pending invitee
 * without resolving their identity, which would re-open the vector the
 * consent model closes. The membership itself confers nothing until the
 * invitee accepts. Runs under the user's own JWT: the admin-only RLS policies
 * on `scope_members` are the fence.
 */
export async function addScopeMember(
  scope: string,
  email: string,
  role: string
): Promise<ActionResult> {
  if (!SCOPE_PATTERN.test(scope)) {
    return { ok: false, error: `Invalid scope path: "${scope}".` };
  }
  if (!['reader', 'writer', 'admin'].includes(role)) {
    return { ok: false, error: `Invalid role: "${role}".` };
  }

  const supabase = await createServerSupabaseClient();

  const { data: memberId, error } = await supabase.rpc('invite_scope_member', {
    p_scope: scope,
    p_email: email,
    p_role: role,
  });
  if (error) {
    return { ok: false, error: error.message };
  }
  if (!memberId) {
    return { ok: false, error: `No user found for "${email}".` };
  }

  revalidatePath('/scopes');
  return { ok: true };
}

/**
 * Revoke a membership. `userId` is the member's usr_ entity id (what
 * `scope_members.user_id` stores and the member list already carries) — no auth
 * uuid bridging needed here. Admin-gated by the scope_members DELETE RLS policy;
 * a non-admin's delete simply matches no rows.
 */
export async function removeScopeMember(
  scope: string,
  userId: string
): Promise<ActionResult> {
  if (!SCOPE_PATTERN.test(scope)) {
    return { ok: false, error: `Invalid scope path: "${scope}".` };
  }
  const supabase = await createServerSupabaseClient();
  const { error } = await supabase
    .from('scope_members')
    .delete()
    .eq('scope', scope)
    .eq('user_id', userId);
  if (error) {
    return { ok: false, error: error.message };
  }

  revalidatePath('/scopes');
  return { ok: true };
}

/**
 * Upsert display metadata of a scope (alias + description). Admin-gated by
 * RLS on public.scopes; a manually saved description is stamped 'human'.
 */
export async function saveScopeMeta(
  scope: string,
  alias: string,
  description: string
): Promise<ActionResult> {
  if (!SCOPE_PATTERN.test(scope)) {
    return { ok: false, error: `Invalid scope path: "${scope}".` };
  }
  const supabase = await createServerSupabaseClient();
  const trimmedAlias = alias.trim();
  const trimmedDescription = description.trim();
  const { error } = await supabase.from('scopes').upsert(
    {
      scope,
      alias: trimmedAlias || null,
      description: trimmedDescription || null,
      description_source: trimmedDescription ? 'human' : null,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'scope' }
  );
  if (error) {
    return { ok: false, error: error.message };
  }
  revalidatePath('/scopes');
  revalidatePath('/memories');
  return { ok: true };
}

/** Rename a scope's slug (admin only; re-paths the whole subtree). */
export async function renameScope(
  scope: string,
  newSlug: string
): Promise<ActionResult> {
  if (!SCOPE_PATTERN.test(scope)) {
    return { ok: false, error: `Invalid scope path: "${scope}".` };
  }
  if (!/^[a-z0-9_]{1,63}$/.test(newSlug)) {
    return { ok: false, error: `Invalid slug: "${newSlug}".` };
  }
  const supabase = await createServerSupabaseClient();
  const { error } = await supabase.rpc('rename_scope', {
    p_scope: scope,
    p_new_slug: newSlug,
  });
  if (error) {
    return { ok: false, error: error.message };
  }
  revalidatePath('/scopes');
  revalidatePath('/memories');
  return { ok: true };
}

/** Pour one scope into another (admin on both; loss-free delete alternative). */
export async function mergeScopes(
  from: string,
  into: string
): Promise<ActionResult> {
  if (!SCOPE_PATTERN.test(from) || !SCOPE_PATTERN.test(into)) {
    return { ok: false, error: 'Invalid scope path.' };
  }
  const supabase = await createServerSupabaseClient();
  const { error } = await supabase.rpc('merge_scopes', {
    p_from: from,
    p_into: into,
  });
  if (error) {
    return { ok: false, error: error.message };
  }
  revalidatePath('/scopes');
  revalidatePath('/memories');
  return { ok: true };
}

/** Hard-delete a scope with every associated row (admin only, irreversible). */
export async function deleteScope(scope: string): Promise<ActionResult> {
  if (!SCOPE_PATTERN.test(scope)) {
    return { ok: false, error: `Invalid scope path: "${scope}".` };
  }
  const supabase = await createServerSupabaseClient();
  const { error } = await supabase.rpc('delete_scope', { p_scope: scope });
  if (error) {
    return { ok: false, error: error.message };
  }
  revalidatePath('/scopes');
  revalidatePath('/memories');
  return { ok: true };
}
