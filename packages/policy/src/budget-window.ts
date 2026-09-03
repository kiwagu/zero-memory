import { inject } from '@workspace/di';

/** The subject's current budget window, as instants. */
export interface BudgetWindow {
  readonly startsAt: string;
  readonly endsAt: string;
}

/**
 * Port: when the subject's current budget window turns over.
 *
 * Separate from the policy provider on purpose: the guard decides with
 * numbers, and the window boundary exists to be shown — a receipt, a tile.
 * The adapter must answer from the same source the spend rollup uses, or the
 * displayed date and the counted window drift apart.
 */
export interface IBudgetWindowReader {
  /** `null` when the subject has no anchor (no profile row). */
  windowFor(subjectId: string): Promise<BudgetWindow | null>;
}

export const BUDGET_WINDOW_READER = Symbol.for(
  'zero-memory:budget-window-reader'
);

export const injectBudgetWindowReader = () => inject(BUDGET_WINDOW_READER);
