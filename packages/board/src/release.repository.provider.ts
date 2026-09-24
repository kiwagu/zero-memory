import { inject } from '@workspace/di';

export type { IReleaseRepository } from './release.repository.js';

export const RELEASE_REPOSITORY = Symbol.for('zero-memory:release-repository');

export const injectReleaseRepository = () => inject(RELEASE_REPOSITORY);
