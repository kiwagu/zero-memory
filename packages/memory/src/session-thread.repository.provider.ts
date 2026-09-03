import { inject } from '@workspace/di';

export const SESSION_THREAD_REPOSITORY = Symbol.for(
  'zero-memory:session-thread-repository'
);

export const injectSessionThreadRepository = () =>
  inject(SESSION_THREAD_REPOSITORY);
