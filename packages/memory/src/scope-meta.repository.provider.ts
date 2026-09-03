import { inject } from '@workspace/di';

export const SCOPE_META_REPOSITORY = Symbol.for(
  'zero-memory:scope-meta-repository'
);

export const injectScopeMetaRepository = () => inject(SCOPE_META_REPOSITORY);
