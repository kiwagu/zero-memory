import type { BudgetId } from './budget.js';
import type { IPolicyProvider, Policy } from './policy.js';

const envKey = (budgetId: BudgetId, field: 'LIMIT' | 'WINDOW_DAYS'): string =>
  `ZM_POLICY_${budgetId.toUpperCase()}_${field}`;

/**
 * Parse a positive integer, or nothing.
 *
 * Anything unusable — blank, non-numeric, zero, negative, fractional — reads
 * as "not configured" rather than as an error. A typo in an operator's
 * environment must not be able to stop the server from starting or, worse,
 * be rounded into a limit nobody intended.
 */
const positiveInteger = (raw: string | undefined): number | undefined => {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (trimmed === '') return undefined;
  const value = Number(trimmed);
  if (!Number.isInteger(value) || value <= 0) return undefined;
  return value;
};

/**
 * Instance-level allowances read from the environment (`ZM_POLICY_*`).
 *
 * This is the whole configuration surface a self-hosted operator needs to cap
 * their own spend on their own API key: `ZM_POLICY_EXTRACTION_LIMIT=2000000`
 * and nothing else. Process environment is per-process, so it can only carry
 * instance-wide values — anything that has to differ between users comes from
 * the more specific provider after this one.
 */
export class EnvPolicyProvider implements IPolicyProvider {
  readonly source = 'env';

  constructor(private readonly env: NodeJS.ProcessEnv = process.env) {}

  policyFor(budgetId: BudgetId): Promise<Partial<Policy> | undefined> {
    const limit = positiveInteger(this.env[envKey(budgetId, 'LIMIT')]);
    const windowDays = positiveInteger(
      this.env[envKey(budgetId, 'WINDOW_DAYS')]
    );
    if (limit === undefined && windowDays === undefined) {
      return Promise.resolve(undefined);
    }
    return Promise.resolve({
      ...(limit === undefined ? {} : { limit }),
      ...(windowDays === undefined ? {} : { windowDays }),
    } satisfies Partial<Policy>);
  }
}
