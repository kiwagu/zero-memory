/**
 * The registry of everything this server is willing to meter and cap.
 *
 * It is deliberately enumerable and exhaustive: an operation that does not
 * appear here can never be limited, because the guard has no name to look up.
 * Only operations that cost real money per invocation belong here — the LLM
 * calls. Storage, recall, briefings, and export are never budgeted, on any
 * deployment: reading your own data must not depend on an allowance.
 */

/** Who a budget is counted against. */
export type BudgetSubjectKind =
  /** Counted per end user — the work was requested by that user. */
  | 'subject'
  /** Counted for the whole instance — background work nobody requested. */
  | 'instance';

export interface BudgetDefinition {
  /** Stable identifier; also the suffix of its environment override. */
  readonly id: BudgetId;
  readonly subjectKind: BudgetSubjectKind;
  /** What `limit` and `spent` are counted in. */
  readonly unit: 'tokens';
  /** Length of the rolling window the spend is summed over. */
  readonly windowDays: number;
  /** Human-facing label for the budget vitrine. */
  readonly label: string;
}

/**
 * `maintenance` is separate from `extraction` on purpose. Background upkeep
 * (the hygiene judge, reflection, ROI probes) is not attributable to any one
 * user — the ledger records it with no user id — so a per-user allowance
 * physically cannot see it. It gets its own instance-wide budget instead of
 * being silently unbounded.
 */
export const BUDGETS = {
  extraction: {
    id: 'extraction',
    subjectKind: 'subject',
    unit: 'tokens',
    windowDays: 30,
    label: 'Memory extraction',
  },
  maintenance: {
    id: 'maintenance',
    subjectKind: 'instance',
    unit: 'tokens',
    windowDays: 30,
    label: 'Background upkeep',
  },
  translation: {
    id: 'translation',
    subjectKind: 'subject',
    unit: 'tokens',
    windowDays: 30,
    label: 'Translation',
  },
} as const satisfies Record<
  string,
  Omit<BudgetDefinition, 'id'> & { id: string }
>;

export type BudgetId = keyof typeof BUDGETS;

export const budgetIds = Object.keys(BUDGETS) as readonly BudgetId[];

export const isBudgetId = (value: string): value is BudgetId =>
  Object.prototype.hasOwnProperty.call(BUDGETS, value);

export const budgetDefinition = (id: BudgetId): BudgetDefinition =>
  BUDGETS[id] as BudgetDefinition;
