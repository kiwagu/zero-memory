import { inject } from '@workspace/di';

export const SCOPE_ACCESS_SERVICE = Symbol.for('zero-memory:scope-access');

export const injectScopeAccessService = () => inject(SCOPE_ACCESS_SERVICE);
