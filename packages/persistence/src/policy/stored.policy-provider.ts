import { singleton } from '@workspace/di';
import type { BudgetId, IPolicyProvider, Policy } from '@workspace/policy';

import { createServiceRoleClient, type Client } from '../supabase.client.js';

/**
 * Per-subject allowances read from `public.policy_allowances`.
 *
 * This is the most specific link in the resolution chain and therefore the
 * last to speak. It exists because the environment layer above it is
 * process-global: an instance that has to hold a different allowance per user
 * cannot express that in environment variables at all.
 *
 * A missing row returns `undefined` — "no opinion", not a ceiling of zero.
 * That distinction is the whole safety property of the chain: absence must
 * never be readable as a limit, or a deployment that simply stores nothing
 * would find every metered operation blocked.
 */
@singleton()
export class StoredPolicyProvider implements IPolicyProvider {
  readonly source = 'stored';

  #client: Client | null = null;

  async policyFor(
    budgetId: BudgetId,
    subjectId: string | null
  ): Promise<Partial<Policy> | undefined> {
    // Instance-wide budgets have no subject to look up; their values come from
    // the environment layer instead.
    if (subjectId === null) return undefined;

    const { data, error } = await this.#serviceClient()
      .from('policy_allowances')
      .select('limit_value, window_days')
      .eq('subject_id', subjectId)
      .eq('budget_id', budgetId)
      .maybeSingle();

    // Surfaced, not swallowed: the guard treats an unreachable provider as
    // "nothing to add" and keeps whatever was already resolved, but it can
    // only report that if the failure reaches it.
    if (error) {
      throw new Error(
        `Failed to read the allowance for "${budgetId}": ${error.message}`
      );
    }
    if (data === null) return undefined;

    return {
      // A stored NULL is an explicit "unlimited", which is how a row can lift
      // a ceiling the environment set — distinct from having no row at all.
      limit: data.limit_value === null ? null : Number(data.limit_value),
      ...(data.window_days === null ? {} : { windowDays: data.window_days }),
    } satisfies Partial<Policy>;
  }

  #serviceClient(): Client {
    this.#client ??= createServiceRoleClient();
    return this.#client;
  }
}
