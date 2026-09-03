'use server';

import { revalidatePath } from 'next/cache';

import {
  rememberViaServer,
  scanHygieneViaServer,
  type RememberedMemory,
} from './mcp';
import { createServerSupabaseClient } from './supabase/server';
import { currentUserEntityId } from './user';

type SupabaseServerClient = Awaited<
  ReturnType<typeof createServerSupabaseClient>
>;

export type ActionResult = { ok: true } | { ok: false; error: string };

/**
 * A human's decision on a queued conflict:
 *   - keep_both        — dismiss; both memories stay (not really a conflict)
 *   - forget_a/b       — invalidate the chosen memory
 *   - supersede_a_b    — memory A wins, B is superseded (invalidated + linked)
 *   - supersede_b_a    — memory B wins, A is superseded
 */
export type ReviewResolution =
  'keep_both' | 'forget_a' | 'forget_b' | 'supersede_a_b' | 'supersede_b_a';

/**
 * Resolve one review-queue conflict. Runs as the signed-in owner: RLS gates the
 * queue row (owner of both memories) and the memory writes, so a caller can only
 * ever act on their own pair. The memory effect is applied first, then the row
 * is flipped to resolved/dismissed with the decision and actor recorded.
 */
export async function resolveConflict(
  queueId: string,
  resolution: ReviewResolution,
  // The memory ids as DISPLAYED (A = left, B = right). Passed explicitly because
  // the display order (by time) differs from the row's canonical a/b order, so
  // positional actions must resolve against what the user actually saw.
  memoryAId: string,
  memoryBId: string
): Promise<ActionResult> {
  const supabase = await createServerSupabaseClient();
  const userId = await currentUserEntityId(supabase);
  if (!userId) {
    return { ok: false, error: 'Not signed in.' };
  }

  const { data: row, error: loadError } = await supabase
    .from('memory_review_queue')
    .select('id, memory_a, memory_b, status')
    .eq('id', queueId)
    .single();
  if (loadError || !row) {
    return { ok: false, error: 'Review item not found or not permitted.' };
  }
  if (row.status !== 'pending') {
    return { ok: false, error: 'This conflict was already resolved.' };
  }
  // The displayed pair must be this row's pair (order-independent).
  const rowPair = new Set([row.memory_a, row.memory_b]);
  if (
    rowPair.size !== 2 ||
    !rowPair.has(memoryAId) ||
    !rowPair.has(memoryBId)
  ) {
    return { ok: false, error: 'Review item does not match this conflict.' };
  }

  if (resolution === 'forget_a' || resolution === 'forget_b') {
    const target = resolution === 'forget_a' ? memoryAId : memoryBId;
    const failure = await invalidateOwned(supabase, target, userId);
    if (failure) {
      return { ok: false, error: failure };
    }
  } else if (resolution === 'supersede_a_b' || resolution === 'supersede_b_a') {
    const [winner, loser] =
      resolution === 'supersede_a_b'
        ? [memoryAId, memoryBId]
        : [memoryBId, memoryAId];
    const failure = await supersedeOwned(supabase, loser, winner, userId);
    if (failure) {
      return { ok: false, error: failure };
    }
  }
  // keep_both leaves both memories untouched.

  const status = resolution === 'keep_both' ? 'dismissed' : 'resolved';
  const { error: updateError } = await supabase
    .from('memory_review_queue')
    .update({
      status,
      resolution,
      resolved_by: userId,
      resolved_at: new Date().toISOString(),
    })
    .eq('id', queueId);
  if (updateError) {
    return { ok: false, error: updateError.message };
  }

  revalidatePath('/review');
  return { ok: true };
}

/**
 * Runs the hygiene scan over the caller's own memories (via the server, which
 * holds the judge key + service-role). Auto-resolves confident duplicates and
 * queues genuine conflicts; the page then shows the refreshed queue.
 */
export async function scanForDuplicates(limit?: number): Promise<ActionResult> {
  const supabase = await createServerSupabaseClient();
  const accessToken = (await supabase.auth.getSession()).data.session
    ?.access_token;
  if (!accessToken) {
    return { ok: false, error: 'Not signed in.' };
  }
  try {
    await scanHygieneViaServer(accessToken, limit);
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
  revalidatePath('/review');
  return { ok: true };
}

/**
 * Merge a conflicting pair into a new memory the user writes. The merged text is
 * stored through the server's `remember` (the only path that embeds it), then
 * both originals are superseded by it and the queue row is resolved. Runs as the
 * signed-in owner; RLS gates every write.
 */
export async function mergeConflict(
  queueId: string,
  mergedContent: string
): Promise<ActionResult> {
  const content = mergedContent.trim();
  if (!content) {
    return { ok: false, error: 'The merged memory cannot be empty.' };
  }

  const supabase = await createServerSupabaseClient();
  const userId = await currentUserEntityId(supabase);
  const accessToken = (await supabase.auth.getSession()).data.session
    ?.access_token;
  if (!userId || !accessToken) {
    return { ok: false, error: 'Not signed in.' };
  }

  const { data: row, error: loadError } = await supabase
    .from('memory_review_queue')
    .select('id, memory_a, memory_b, status')
    .eq('id', queueId)
    .single();
  if (loadError || !row) {
    return { ok: false, error: 'Review item not found or not permitted.' };
  }
  if (row.status !== 'pending') {
    return { ok: false, error: 'This conflict was already resolved.' };
  }
  // The dashboard merges PAIRS; single-subject disputes (challenged /
  // stale_suspect) have nothing to merge.
  if (row.memory_b === null) {
    return { ok: false, error: 'This dispute has no second memory to merge.' };
  }

  // Place the merged memory where memory A lived.
  const { data: source } = await supabase
    .from('memories')
    .select('scope')
    .eq('id', row.memory_a)
    .single();

  let merged: RememberedMemory;
  try {
    // memories.scope is ltree, generated as `unknown`; it is a string on the wire.
    const scope = source?.scope as string | undefined;
    merged = await rememberViaServer(accessToken, content, scope);
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
  const mergedId = merged.id;

  // The one write in this product a PERSON actually authors: the owner typed
  // this text into the merge form. `remember` stamps every write it embeds as
  // agent-authored — it cannot tell who was at the keyboard — so the record is
  // corrected here, by the signed-in owner, under the same RLS that gates the
  // supersessions below. Skipped when the text collapsed onto an existing
  // memory: that row is somebody else's write and its authorship stands.
  if (!merged.deduplicated) {
    const { error: authorError } = await supabase
      .from('memories')
      .update({ author_kind: 'human' })
      .eq('id', mergedId)
      .eq('owner_id', userId);
    if (authorError) {
      return { ok: false, error: authorError.message };
    }
  }

  // Supersede both originals by the merged memory. If `remember` deduplicated
  // the merged text onto one of them, that one IS the winner — never supersede
  // it by itself.
  for (const loser of [row.memory_a, row.memory_b]) {
    if (loser === mergedId) {
      continue;
    }
    const failure = await supersedeOwned(supabase, loser, mergedId, userId);
    if (failure) {
      return { ok: false, error: failure };
    }
  }

  const { error: updateError } = await supabase
    .from('memory_review_queue')
    .update({
      status: 'resolved',
      resolution: 'merge',
      resolved_by: userId,
      resolved_at: new Date().toISOString(),
    })
    .eq('id', queueId);
  if (updateError) {
    return { ok: false, error: updateError.message };
  }

  revalidatePath('/review');
  return { ok: true };
}

/** Soft-invalidate a memory the caller owns. Returns an error message or null. */
async function invalidateOwned(
  supabase: SupabaseServerClient,
  memoryId: string,
  userId: string
): Promise<string | null> {
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
    return error.message;
  }
  if (!data || data.length === 0) {
    return 'Memory not found, already invalidated, or not owned by you.';
  }
  return null;
}

/** Supersede loser by winner (invalidate loser, record replacement + link). */
async function supersedeOwned(
  supabase: SupabaseServerClient,
  loserId: string,
  winnerId: string,
  userId: string
): Promise<string | null> {
  const { data, error } = await supabase
    .from('memories')
    .update({
      superseded_by: winnerId,
      invalidated_at: new Date().toISOString(),
      invalidated_by: userId,
    })
    .eq('id', loserId)
    .eq('owner_id', userId)
    .is('invalidated_at', null)
    .select('id');
  if (error) {
    return error.message;
  }
  if (!data || data.length === 0) {
    return 'Memory not found, already invalidated, or not owned by you.';
  }
  // Best-effort provenance: winner supersedes loser.
  await supabase
    .from('memory_links')
    .upsert(
      { src: winnerId, dst: loserId, type: 'supersedes' },
      { onConflict: 'src,dst,type', ignoreDuplicates: true }
    );
  return null;
}
