import { inject } from '@workspace/di';

export const PROJECT_RULES_READER = Symbol.for(
  'zero-memory:project-rules-reader'
);

export const injectProjectRulesReader = () => inject(PROJECT_RULES_READER);
