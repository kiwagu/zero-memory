import { inject } from '@workspace/di';

export const EMBEDDING_SERVICE = Symbol.for('zero-memory:embedding-service');

export const injectEmbeddingService = () => inject(EMBEDDING_SERVICE);
