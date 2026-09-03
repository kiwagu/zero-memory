import { singleton } from '@workspace/di';
import type { BudgetWindow, IBudgetWindowReader } from '@workspace/policy';

import { createServiceRoleClient, type Client } from '../supabase.client.js';

/**
 * Reads the subject's current window boundary from `public.policy_period` —
 * the same function the spend rollup anchors on, so the date shown and the
 * window counted can never disagree.
 */
@singleton()
export class SupabaseBudgetWindowReader implements IBudgetWindowReader {
  #client: Client | null = null;

  async windowFor(subjectId: string): Promise<BudgetWindow | null> {
    const { data, error } = await this.#serviceClient().rpc('policy_period', {
      p_subject_id: subjectId,
    });
    if (error) {
      throw new Error(`Failed to read the budget window: ${error.message}`);
    }
    const row = Array.isArray(data) ? data[0] : data;
    if (!row || row.starts_at === null || row.ends_at === null) return null;
    return { startsAt: row.starts_at, endsAt: row.ends_at };
  }

  #serviceClient(): Client {
    this.#client ??= createServiceRoleClient();
    return this.#client;
  }
}
