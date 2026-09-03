import { singleton } from '@workspace/di';
import type { BudgetId, ISpendMeter } from '@workspace/policy';

import { createServiceRoleClient, type Client } from '../supabase.client.js';

/**
 * Supabase adapter for the spend-meter port.
 *
 * Delegates the sum to `public.policy_spend` rather than fetching rows and
 * adding them up here: the ledger grows without bound, and a guard that had to
 * read a window's worth of events before every metered call would get slower
 * exactly as a deployment got busier.
 *
 * The rollup reads across every user's ledger rows, so it is not exposed to
 * end users — it goes through the privileged client, built lazily so a server
 * without a service-role key still boots when no budget is ever configured.
 */
@singleton()
export class SupabaseSpendMeter implements ISpendMeter {
  #client: Client | null = null;

  async spent(
    budgetId: BudgetId,
    windowDays: number,
    subjectId: string | null
  ): Promise<number> {
    const { data, error } = await this.#serviceClient().rpc('policy_spend', {
      p_budget_id: budgetId,
      p_window_days: windowDays,
      // An instance-wide budget has no subject; the argument defaults to NULL
      // in SQL, so it is omitted rather than sent as an explicit null.
      p_subject_id: subjectId ?? undefined,
    });
    if (error) {
      throw new Error(
        `Failed to read spend for "${budgetId}": ${error.message}`
      );
    }
    return Number(data ?? 0);
  }

  #serviceClient(): Client {
    this.#client ??= createServiceRoleClient();
    return this.#client;
  }
}
