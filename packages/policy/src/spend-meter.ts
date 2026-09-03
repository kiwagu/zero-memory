import { inject } from '@workspace/di';

import type { BudgetId } from './budget.js';

/**
 * Port: how much of a budget has already been consumed.
 *
 * Spend is never stored as a mutable counter. It is derived by summing the
 * append-only usage ledger over the window, which means there is nothing to
 * decrement concurrently, nothing that can drift out of step with the events
 * it claims to summarise, and any figure the guard acted on can be recomputed
 * afterwards from the same rows.
 */
export interface ISpendMeter {
  /**
   * Consumed units inside the trailing `windowDays`. `subjectId` is null for
   * instance-wide budgets.
   */
  spent(
    budgetId: BudgetId,
    windowDays: number,
    subjectId: string | null
  ): Promise<number>;
}

export const SPEND_METER = Symbol.for('zero-memory:spend-meter');

export const injectSpendMeter = () => inject(SPEND_METER);
