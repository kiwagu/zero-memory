import { inject } from '@workspace/di';

export const MEMORY_REPOSITORY = Symbol.for('zero-memory:memory-repository');

export const injectMemoryRepository = () => inject(MEMORY_REPOSITORY);
