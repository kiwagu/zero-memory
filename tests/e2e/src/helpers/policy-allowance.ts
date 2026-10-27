/**
 * The extraction allowance of one subject, written with the service role: the
 * ceiling the budget guard and the dashboard's budget tile read. A spec sets
 * it for its own subject and clears it afterwards, so the next spec meets the
 * instance default again.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import { e2eEnv } from './env.js';

const adminClient = (): SupabaseClient =>
  createClient(e2eEnv.supabaseUrl, e2eEnv.supabaseServiceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

/** Sets the subject's extraction ceiling; `null` means no ceiling at all. */
export const setAllowance = async (
  subjectId: string,
  limitValue: number | null
): Promise<void> => {
  const { error } = await adminClient().from('policy_allowances').upsert({
    subject_id: subjectId,
    budget_id: 'extraction',
    limit_value: limitValue,
  });
  if (error) {
    throw new Error(`could not store an allowance: ${error.message}`);
  }
};

/** Removes the subject's extraction allowance row. */
export const clearAllowance = async (subjectId: string): Promise<void> => {
  await adminClient()
    .from('policy_allowances')
    .delete()
    .eq('subject_id', subjectId)
    .eq('budget_id', 'extraction');
};
