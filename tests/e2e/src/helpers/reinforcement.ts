/**
 * Sets a memory's precomputed reinforcement multiplier through the
 * service-role client — the state the hygiene rollup would produce. The
 * ranking specs assert the search-side wiring, not the rollup math (that is
 * unit-tested where the curve lives).
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import { e2eEnv } from './env.js';

const adminClient = (): SupabaseClient =>
  createClient(e2eEnv.supabaseUrl, e2eEnv.supabaseServiceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

export const setReinforcementMultiplier = async (
  memoryId: string,
  multiplier: number
): Promise<void> => {
  const { error } = await adminClient().from('memory_reinforcement').upsert(
    {
      memory_id: memoryId,
      multiplier,
      useful_events: 1,
    },
    { onConflict: 'memory_id' }
  );
  if (error) {
    throw new Error(
      `reinforcement seed for ${memoryId} failed: ${error.message}`
    );
  }
};
