'use server';

import { revalidatePath } from 'next/cache';

import { moveMemoriesViaServer } from './mcp';
import { createServerSupabaseClient } from './supabase/server';

export type MigrateResult =
  { ok: true; moved: number; scope: string } | { ok: false; error: string };

/**
 * Moves ONE memory into the chosen project scope — the manual re-scope from
 * the memory detail page. Works for any owned, valid memory (not only stamped
 * fallbacks): the human moving a memory in the UI is the ground truth of
 * where it belongs.
 */
export async function moveMemoryToScope(
  memoryId: string,
  targetScope: string
): Promise<MigrateResult> {
  const supabase = await createServerSupabaseClient();
  const accessToken = (await supabase.auth.getSession()).data.session
    ?.access_token;
  if (!accessToken) {
    return { ok: false, error: 'No session token.' };
  }
  if (!targetScope.startsWith('proj.')) {
    return { ok: false, error: 'Target must be a project scope.' };
  }
  try {
    const result = await moveMemoriesViaServer(
      accessToken,
      [memoryId],
      targetScope
    );
    if (result.failed.length > 0) {
      return { ok: false, error: result.failed[0]?.error ?? 'move failed' };
    }
    revalidatePath(`/memory/${memoryId}`);
    revalidatePath('/memories');
    return { ok: true, moved: result.moved.length, scope: result.scope };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
