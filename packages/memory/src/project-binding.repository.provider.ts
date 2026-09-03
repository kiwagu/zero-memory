import { inject } from '@workspace/di';

export const PROJECT_BINDING_REPOSITORY = Symbol.for(
  'zero-memory:project-binding-repository'
);

export const injectProjectBindingRepository = () =>
  inject(PROJECT_BINDING_REPOSITORY);
