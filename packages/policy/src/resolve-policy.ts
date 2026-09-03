import { budgetDefinition, type BudgetId } from './budget.js';
import {
  unlimitedPolicy,
  type IPolicyProvider,
  type Policy,
} from './policy.js';

export interface ResolvedPolicy extends Policy {
  /** Which provider supplied the limit — recorded with the guard decision. */
  readonly source: string;
}

/**
 * Resolve one budget by walking the providers in order, most specific last.
 *
 * The chain starts from the built-in unlimited default and lets each provider
 * override the fields it knows about; the last one to speak wins. A provider
 * that throws is skipped rather than fatal — an allowance source being
 * unreachable must not take generation down with it, and the values already
 * resolved stay in force.
 */
export const resolvePolicy = async (
  budgetId: BudgetId,
  subjectId: string | null,
  providers: readonly IPolicyProvider[],
  onProviderError?: (source: string, error: unknown) => void
): Promise<ResolvedPolicy> => {
  const { windowDays } = budgetDefinition(budgetId);
  let resolved: ResolvedPolicy = {
    ...unlimitedPolicy(windowDays),
    source: 'default',
  };

  for (const provider of providers) {
    let patch: Partial<Policy> | undefined;
    try {
      patch = await provider.policyFor(budgetId, subjectId);
    } catch (error: unknown) {
      onProviderError?.(provider.source, error);
      continue;
    }
    if (patch === undefined) continue;
    resolved = {
      limit: patch.limit === undefined ? resolved.limit : patch.limit,
      windowDays: patch.windowDays ?? resolved.windowDays,
      source: provider.source,
    };
  }

  return resolved;
};
