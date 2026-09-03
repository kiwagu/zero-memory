import { describe, expect, it } from 'vitest';

import {
  ERROR_CODE_HTTP_STATUS,
  errorCodeOf,
  errorCodeSchema,
  FailureError,
  failure,
  internalFailure,
  notFound,
  toolErrorSchema,
  validationFailed,
} from './error.schema.js';

describe('errorCodeSchema', () => {
  it('is the closed seven-code taxonomy', () => {
    expect(errorCodeSchema.options).toEqual([
      'validation_failed',
      'unauthorized',
      'forbidden',
      'not_found',
      'conflict',
      'rate_limited',
      'internal',
    ]);
  });

  it('rejects a code outside the taxonomy', () => {
    expect(errorCodeSchema.safeParse('teapot').success).toBe(false);
  });
});

describe('toolErrorSchema', () => {
  it('accepts a body with optional details omitted', () => {
    const body = { error: { code: 'not_found', message: 'No such memory.' } };
    expect(toolErrorSchema.parse(body)).toEqual(body);
  });

  it('carries structured details when present', () => {
    const parsed = toolErrorSchema.parse({
      error: {
        code: 'validation_failed',
        message: 'Pass exactly one mode.',
        details: { passed: ['policy', 'resolutions'] },
      },
    });
    expect(parsed.error.details).toEqual({
      passed: ['policy', 'resolutions'],
    });
  });

  it('rejects a bare string error — the shape is the contract', () => {
    expect(toolErrorSchema.safeParse({ error: 'not_found' }).success).toBe(
      false
    );
  });
});

describe('ERROR_CODE_HTTP_STATUS', () => {
  it('maps every code in the taxonomy', () => {
    expect(Object.keys(ERROR_CODE_HTTP_STATUS).sort()).toEqual(
      [...errorCodeSchema.options].sort()
    );
  });

  it('maps codes to their conventional statuses', () => {
    expect(ERROR_CODE_HTTP_STATUS.validation_failed).toBe(400);
    expect(ERROR_CODE_HTTP_STATUS.rate_limited).toBe(429);
    expect(ERROR_CODE_HTTP_STATUS.internal).toBe(500);
  });
});

describe('errorCodeOf', () => {
  it('reads a taxonomy code off a thrown error', () => {
    const error = Object.assign(new Error('nope'), { code: 'forbidden' });
    expect(errorCodeOf(error)).toBe('forbidden');
  });

  it('ignores a code outside the taxonomy', () => {
    const error = Object.assign(new Error('nope'), { code: 'ECONNRESET' });
    expect(errorCodeOf(error)).toBeNull();
  });

  it('tolerates non-object throws', () => {
    expect(errorCodeOf('boom')).toBeNull();
    expect(errorCodeOf(null)).toBeNull();
    expect(errorCodeOf(undefined)).toBeNull();
  });
});

describe('failure helpers', () => {
  it('builds a failure carrying its code and message', () => {
    expect(failure('conflict', 'Already pending.')).toEqual({
      code: 'conflict',
      message: 'Already pending.',
    });
  });

  it('names the codes a caller can act on', () => {
    expect(validationFailed('Rewrite it.').code).toBe('validation_failed');
    expect(notFound('No such memory.').code).toBe('not_found');
    expect(internalFailure('Embedder is down.').code).toBe('internal');
  });
});

describe('FailureError', () => {
  it('carries the code where errorCodeOf can read it', () => {
    const thrown = new FailureError(validationFailed('Rewrite it.'));
    expect(errorCodeOf(thrown)).toBe('validation_failed');
  });

  it('keeps the failure message as the error message', () => {
    // The boundary passes the message through to the calling agent, so the
    // service's course-correction wording must survive the throw.
    const thrown = new FailureError(notFound('Memory mem_1 was not found.'));
    expect(thrown.message).toBe('Memory mem_1 was not found.');
    expect(thrown).toBeInstanceOf(Error);
  });
});
