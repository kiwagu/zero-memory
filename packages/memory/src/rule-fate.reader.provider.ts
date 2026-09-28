import { inject } from '@workspace/di';

export const RULE_FATE_READER = Symbol.for('zero-memory:rule-fate-reader');

export const injectRuleFateReader = () => inject(RULE_FATE_READER);
