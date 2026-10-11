import { describe, expect, it } from 'vitest';

import { isJobEvent, JOB_NAMES } from './lambda.jobs.js';

describe('isJobEvent', () => {
  it('accepts a direct invocation naming a known job', () => {
    for (const job of JOB_NAMES) {
      expect(isJobEvent({ zeroMemory: 'job', job })).toBe(true);
    }
  });

  it('refuses an unknown job, a missing name and anything from the function URL', () => {
    expect(isJobEvent({ zeroMemory: 'job', job: 'drop-tables' })).toBe(false);
    expect(isJobEvent({ zeroMemory: 'job' })).toBe(false);
    expect(isJobEvent({ zeroMemory: 'warm-up' })).toBe(false);
    expect(
      isJobEvent({
        zeroMemory: 'job',
        job: 'usage-upkeep',
        requestContext: { http: { method: 'POST' } },
      })
    ).toBe(false);
    expect(isJobEvent(null)).toBe(false);
  });
});
