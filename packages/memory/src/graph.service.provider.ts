import { inject } from '@workspace/di';

export const GRAPH_SERVICE = Symbol.for('zero-memory:graph-service');

export const injectGraphService = () => inject(GRAPH_SERVICE);
