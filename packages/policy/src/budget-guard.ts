import { budgetDefinition, type BudgetId } from './budget.js';
import { BudgetExhaustedError } from './budget-exhausted.error.js';
import type { IPolicyProvider } from './policy.js';
import { resolvePolicy } from './resolve-policy.js';
import type { ISpendMeter } from './spend-meter.js';

export interface BudgetContext {
  /** End user the work is attributed to; null for instance-wide budgets. */
  readonly subjectId: string | null;
  /**
   * The call runs on credentials the caller supplied themselves. Their spend
   * is billed to them by their own provider, so it is none of this server's
   * business to cap it.
   */
  readonly usesCallerCredentials?: boolean;
  readonly correlationId?: string;
}

export interface BudgetDecision {
  readonly budgetId: BudgetId;
  readonly allowed: boolean;
  /** null when unlimited. */
  readonly limit: number | null;
  readonly spent: number;
  /** null when unlimited. */
  readonly remaining: number | null;
  readonly windowDays: number;
  /** Which provider the limit came from — `default` when nothing configured. */
  readonly source: string;
}

export interface BudgetGuardHooks {
  /** Every decision, allowed or not — this is the audit trail. */
  readonly onDecision?: (
    decision: BudgetDecision,
    context: BudgetContext
  ) => void;
  readonly onProviderError?: (source: string, error: unknown) => void;
}

const unlimitedDecision = (
  budgetId: BudgetId,
  windowDays: number,
  source: string
): BudgetDecision => ({
  budgetId,
  allowed: true,
  limit: null,
  spent: 0,
  remaining: null,
  windowDays,
  source,
});

/**
 * Decides whether one metered operation may proceed.
 *
 * The guard only ever gates *generation*. It is never consulted on a read, a
 * recall, a briefing, or an export — those have no budget to look up, by
 * construction of the registry.
 *
 * Checking and then spending is not atomic, so concurrent calls can carry a
 * budget slightly past its limit. That is accepted: the alternative is a lock
 * around every LLM call, and a small overshoot on a soft ceiling is cheaper
 * than serialising the work it guards.
 */
export class BudgetGuard {
  constructor(
    private readonly providers: readonly IPolicyProvider[],
    private readonly meter: ISpendMeter,
    private readonly hooks: BudgetGuardHooks = {}
  ) {}

  /**
   * Decide whether an operation may run, and put that decision on the record.
   *
   * Use this on the path of the work itself. To merely display where a budget
   * stands — a receipt, a dashboard tile — use {@link status}: showing someone
   * their own numbers is not a decision, and recording it as one would bury
   * the entries that matter in noise.
   */
  async check(
    budgetId: BudgetId,
    context: BudgetContext
  ): Promise<BudgetDecision> {
    const decision = await this.status(budgetId, context);
    this.hooks.onDecision?.(decision, context);
    return decision;
  }

  /** Where a budget stands, without recording a decision. */
  async status(
    budgetId: BudgetId,
    context: BudgetContext
  ): Promise<BudgetDecision> {
    const { windowDays: defaultWindow } = budgetDefinition(budgetId);

    if (context.usesCallerCredentials === true) {
      return unlimitedDecision(budgetId, defaultWindow, 'caller-credentials');
    }

    const policy = await resolvePolicy(
      budgetId,
      context.subjectId,
      this.providers,
      this.hooks.onProviderError
    );

    if (policy.limit === null) {
      return unlimitedDecision(budgetId, policy.windowDays, policy.source);
    }

    const spent = await this.meter.spent(
      budgetId,
      policy.windowDays,
      context.subjectId
    );
    const decision: BudgetDecision = {
      budgetId,
      allowed: spent < policy.limit,
      limit: policy.limit,
      spent,
      remaining: Math.max(0, policy.limit - spent),
      windowDays: policy.windowDays,
      source: policy.source,
    };
    return decision;
  }

  /** {@link check}, raising {@link BudgetExhaustedError} when out of budget. */
  async require(
    budgetId: BudgetId,
    context: BudgetContext
  ): Promise<BudgetDecision> {
    const decision = await this.check(budgetId, context);
    if (!decision.allowed && decision.limit !== null) {
      throw new BudgetExhaustedError(
        {
          budgetId,
          limit: decision.limit,
          spent: decision.spent,
          windowDays: decision.windowDays,
        },
        context.correlationId
      );
    }
    return decision;
  }
}
