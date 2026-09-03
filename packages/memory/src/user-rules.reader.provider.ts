import { inject } from '@workspace/di';

export const USER_RULES_READER = Symbol.for('zero-memory:user-rules-reader');

export const injectUserRulesReader = () => inject(USER_RULES_READER);
