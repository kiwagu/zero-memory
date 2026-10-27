import { inject } from '@workspace/di';

export const BRIEFING_WORK_READER = Symbol.for(
  'zero-memory:briefing-work-reader'
);

export const injectBriefingWorkReader = () => inject(BRIEFING_WORK_READER);
