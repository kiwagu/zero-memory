import { toolErrorSchema } from '@workspace/contracts';
import { describe, expect, it } from 'vitest';

import { errorResponse, errorResponseFromThrown } from './http-error.js';

const bodyOf = async (response: Response) =>
  toolErrorSchema.parse(await response.json());

describe('errorResponse', () => {
  it('derives the status from the code', async () => {
    const response = errorResponse('not_found', 'No route matches this.');
    expect(response.status).toBe(404);
    expect(response.headers.get('content-type')).toBe('application/json');
    expect(await bodyOf(response)).toEqual({
      error: { code: 'not_found', message: 'No route matches this.' },
    });
  });

  it('carries details only when given', async () => {
    const bare = await bodyOf(errorResponse('conflict', 'Already resolved.'));
    expect(bare.error).not.toHaveProperty('details');

    const detailed = await bodyOf(
      errorResponse('validation_failed', 'Bad input.', { field: 'topic' })
    );
    expect(detailed.error.details).toEqual({ field: 'topic' });
  });
});

describe('errorResponseFromThrown', () => {
  it('keeps a taxonomy code the thrown error carries', async () => {
    const thrown = Object.assign(new Error('Not yours.'), {
      code: 'forbidden',
    });
    const response = errorResponseFromThrown(thrown);
    expect(response.status).toBe(403);
    expect((await bodyOf(response)).error.message).toBe('Not yours.');
  });

  it('answers an unrecognised failure as internal without leaking the cause', async () => {
    const response = errorResponseFromThrown(
      new Error('connect ECONNREFUSED 10.0.0.5:5432')
    );
    expect(response.status).toBe(500);
    expect(await bodyOf(response)).toEqual({
      error: { code: 'internal', message: 'Internal server error.' },
    });
  });
});
