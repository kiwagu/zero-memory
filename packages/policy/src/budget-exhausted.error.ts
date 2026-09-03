import { ExceptionBase } from '@workspace/domain';

import type { BudgetId } from './budget.js';

/** Stable prefix clients match on, ahead of the human-readable remainder. */
export const BUDGET_EXHAUSTED = 'budget_exhausted';

export interface BudgetExhaustedMetadata {
  readonly budgetId: BudgetId;
  readonly limit: number;
  readonly spent: number;
  readonly windowDays: number;
}

/**
 * Raised instead of performing a metered call once its budget is used up.
 *
 * Thrown, not swallowed: a caller that cannot generate must find out, so the
 * work can be recorded as deferred and picked up later. Returning an empty
 * result would look like "nothing worth extracting" and would let the ingest
 * ledger mark the chunk done, losing it for good.
 */
/**
 * Recognises the error by its `code` rather than with `instanceof`.
 *
 * The throw and the catch sit in different packages, and an `instanceof` check
 * across that boundary is only as reliable as the module graph happening to
 * resolve one copy of this class — which it does not always do. The code is
 * the stable contract clients already match on, so it is what the check uses.
 */
export const isBudgetExhausted = (error: unknown): boolean =>
  typeof error === 'object' &&
  error !== null &&
  (error as { code?: unknown }).code === BUDGET_EXHAUSTED;

export class BudgetExhaustedError extends ExceptionBase {
  readonly code = BUDGET_EXHAUSTED;

  constructor(metadata: BudgetExhaustedMetadata, correlationId?: string) {
    super(
      `budget "${metadata.budgetId}" is exhausted: ` +
        `${String(metadata.spent)}/${String(metadata.limit)} over the last ` +
        `${String(metadata.windowDays)} days`,
      correlationId,
      undefined,
      metadata
    );
  }
}
