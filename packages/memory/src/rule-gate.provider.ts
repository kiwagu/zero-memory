import { inject } from '@workspace/di';

export const RULE_GATE = Symbol.for('zero-memory:rule-gate');

export const injectRuleGate = () => inject(RULE_GATE);

/**
 * The gate's mode, bands and judge timeout. The host reads them from its env
 * once, at startup, so a malformed value stops the server instead of failing
 * every briefing.
 */
export const RULE_GATE_CONFIG = Symbol.for('zero-memory:rule-gate-config');

export const injectRuleGateConfig = () => inject(RULE_GATE_CONFIG);
