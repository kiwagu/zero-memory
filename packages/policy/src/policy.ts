import type { BudgetId } from './budget.js';

/**
 * A resolved allowance for one budget.
 *
 * `limit: null` means unlimited and is the built-in default for every budget.
 * That default is load-bearing rather than cosmetic: a deployment that
 * configures nothing — the ordinary self-hosted case — runs with no ceilings
 * at all, and no code path degrades because a value failed to arrive. Limits
 * are something an operator opts into, never something absence imposes.
 */
export interface Policy {
  readonly limit: number | null;
  readonly windowDays: number;
}

export const isUnlimited = (policy: Policy): boolean => policy.limit === null;

/** The fail-open default: no ceiling, over the budget's own window. */
export const unlimitedPolicy = (windowDays: number): Policy => ({
  limit: null,
  windowDays,
});

/**
 * Port: where a budget's numbers come from. Implementations are ordered from
 * least to most specific by {@link resolvePolicy}; each returns `undefined`
 * when it has nothing to say about a budget, so the next one is consulted.
 */
export interface IPolicyProvider {
  /** The provider's name, for the audit trail of a guard decision. */
  readonly source: string;
  policyFor(
    budgetId: BudgetId,
    subjectId: string | null
  ): Promise<Partial<Policy> | undefined>;
}
