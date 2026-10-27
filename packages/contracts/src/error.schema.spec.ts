import { describe, expect, it } from 'vitest';

import {
  ERROR_CODE_HTTP_STATUS,
  errorCodeOf,
  errorCodeSchema,
  FailureError,
  notFound,
  toolErrorSchema,
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
});

describe('toolErrorSchema', () => {
  it('rejects a bare string error — the shape is the contract', () => {
    expect(toolErrorSchema.safeParse({ error: 'not_found' }).success).toBe(
      false
    );
  });
});

describe('ERROR_CODE_HTTP_STATUS', () => {
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

describe('FailureError', () => {
  it('keeps the failure message as the error message', () => {
    // The boundary passes the message through to the calling agent, so the
    // service's course-correction wording must survive the throw.
    const thrown = new FailureError(notFound('Memory mem_1 was not found.'));
    expect(thrown.message).toBe('Memory mem_1 was not found.');
    expect(thrown).toBeInstanceOf(Error);
  });
});
