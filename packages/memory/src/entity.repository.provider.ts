import { inject } from '@workspace/di';

export const ENTITY_REPOSITORY = Symbol.for('zero-memory:entity-repository');

export const injectEntityRepository = () => inject(ENTITY_REPOSITORY);
