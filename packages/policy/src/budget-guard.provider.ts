import { inject } from '@workspace/di';

export const BUDGET_GUARD = Symbol.for('zero-memory:budget-guard');

export const injectBudgetGuard = () => inject(BUDGET_GUARD);
