/**
 * Ages memories for the decay specs through the service-role client: the
 * fixture is written through the normal `remember` path (real embedding,
 * scope, guard), then its created_at is rewound — the only fact ranking-time
 * decay looks at. Update-only: nothing here deletes or invalidates.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import { e2eEnv } from './env.js';

const adminClient = (): SupabaseClient =>
  createClient(e2eEnv.supabaseUrl, e2eEnv.supabaseServiceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

/** Rewinds a memory's created_at to `ageDays` days ago. */
export const backdateMemory = async (
  memoryId: string,
  ageDays: number
): Promise<void> => {
  const createdAt = new Date(
    Date.now() - ageDays * 24 * 60 * 60 * 1000
  ).toISOString();
  const { error } = await adminClient()
    .from('memories')
    .update({ created_at: createdAt })
    .eq('id', memoryId);
  if (error) {
    throw new Error(`backdate memory ${memoryId} failed: ${error.message}`);
  }
};
