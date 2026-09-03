import { inject } from '@workspace/di';

export const INGEST_LOG_REPOSITORY = Symbol.for(
  'zero-memory:ingest-log-repository'
);

export const injectIngestLogRepository = () => inject(INGEST_LOG_REPOSITORY);
