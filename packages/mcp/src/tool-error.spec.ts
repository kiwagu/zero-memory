import {
  FailureError,
  notFound,
  toolErrorSchema,
  validationFailed,
} from '@workspace/contracts';
import { describe, expect, it } from 'vitest';

import { toolError, toolErrorFromThrown } from './tool-error.js';

const bodyOf = (result: { content: unknown[] }) =>
  toolErrorSchema.parse(
    JSON.parse((result.content[0] as { text: string }).text)
  );

describe('toolError', () => {
  it('marks the result as an error and carries the taxonomy body', () => {
    const result = toolError('not_found', 'Conflict not found or not yours.');
    expect(result.isError).toBe(true);
    expect(bodyOf(result)).toEqual({
      error: { code: 'not_found', message: 'Conflict not found or not yours.' },
    });
  });

  it('includes details only when given', () => {
    expect(bodyOf(toolError('internal', 'boom')).error).not.toHaveProperty(
      'details'
    );
    expect(
      bodyOf(toolError('validation_failed', 'bad input', { field: 'winner' }))
        .error.details
    ).toEqual({ field: 'winner' });
  });

  it('puts the body in the first text block, where payload readers look', () => {
    const result = toolError('forbidden', 'Not yours.');
    expect(result.content).toHaveLength(1);
    expect((result.content[0] as { type: string }).type).toBe('text');
  });
});

describe('toolErrorFromThrown', () => {
  it('keeps a taxonomy code carried by the thrown error', () => {
    const thrown = Object.assign(new Error('Not yours.'), {
      code: 'forbidden',
    });
    expect(bodyOf(toolErrorFromThrown(thrown)).error).toEqual({
      code: 'forbidden',
      message: 'Not yours.',
    });
  });

  it('classifies an unrecognised failure as internal', () => {
    expect(
      bodyOf(toolErrorFromThrown(new Error('socket hang up'))).error
    ).toEqual({ code: 'internal', message: 'socket hang up' });
  });

  it('survives a non-Error throw', () => {
    expect(bodyOf(toolErrorFromThrown('boom')).error.message).toBe('boom');
  });

  // The write paths answer with a Result and their command handlers rethrow
  // the failure. This is the seam where a caller-fixable rejection used to
  // lose its class and reach the agent as `internal`.
  it('preserves the class of a failure a command handler rethrew', () => {
    const rejection = new FailureError(
      validationFailed(
        'secret_content_rejected: content contains what looks like a secret.'
      )
    );
    expect(bodyOf(toolErrorFromThrown(rejection)).error).toEqual({
      code: 'validation_failed',
      message:
        'secret_content_rejected: content contains what looks like a secret.',
    });
  });

  it('reports a missing record as not_found, not as a server fault', () => {
    const rejection = new FailureError(notFound('Memory mem_1 was not found.'));
    expect(bodyOf(toolErrorFromThrown(rejection)).error.code).toBe('not_found');
  });
});
