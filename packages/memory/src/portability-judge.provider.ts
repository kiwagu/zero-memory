import { inject } from '@workspace/di';

export const PORTABILITY_JUDGE = Symbol.for('zero-memory:portability-judge');

export const injectPortabilityJudge = () => inject(PORTABILITY_JUDGE);
