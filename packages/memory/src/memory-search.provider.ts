import { inject } from '@workspace/di';

export const MEMORY_SEARCH_SERVICE = Symbol.for(
  'zero-memory:memory-search-service'
);

export const injectMemorySearchService = () => inject(MEMORY_SEARCH_SERVICE);
