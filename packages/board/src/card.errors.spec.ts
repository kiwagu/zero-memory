import { describe, expect, it } from 'vitest';

import {
  cardFailureToErrorCode,
  isCardFailureCode,
  toCardFailure,
} from './card.errors.js';

describe('toCardFailure', () => {
  it("keeps the store's own message when it sent one", () => {
    expect(toCardFailure('same_state', 'already active')).toEqual({
      code: 'same_state',
      message: 'already active',
    });
  });

  it('falls back to a sentence the caller can act on', () => {
    expect(toCardFailure('archived').message).toMatch(/archived/i);
    expect(toCardFailure('not_attached').message).toMatch(/attached/i);
  });

  it('never passes an unknown code through', () => {
    expect(toCardFailure('kaboom').code).toBe('invalid');
    expect(toCardFailure(undefined).code).toBe('invalid');
    expect(isCardFailureCode('kaboom')).toBe(false);
  });

  it('treats a blank message as no message', () => {
    expect(toCardFailure('forbidden', '   ').message).toMatch(/not write/i);
  });
});

describe('cardFailureToErrorCode', () => {
  it('maps the caller-fixable classes onto the transport vocabulary', () => {
    expect(cardFailureToErrorCode(toCardFailure('invalid'))).toBe(
      'validation_failed'
    );
    expect(cardFailureToErrorCode(toCardFailure('not_found'))).toBe(
      'not_found'
    );
    expect(cardFailureToErrorCode(toCardFailure('forbidden'))).toBe(
      'forbidden'
    );
  });

  it('calls every state refusal a conflict, whatever its reason', () => {
    for (const code of [
      'archived',
      'same_state',
      'conflict',
      'not_attached',
      'already_promoted',
    ] as const) {
      expect(cardFailureToErrorCode(toCardFailure(code))).toBe('conflict');
    }
  });
});

describe('the branch rule', () => {
  it('maps the branch rule onto the transport vocabulary', () => {
    expect(cardFailureToErrorCode(toCardFailure('branch_required'))).toBe(
      'validation_failed'
    );
    expect(cardFailureToErrorCode(toCardFailure('branch_open'))).toBe(
      'conflict'
    );
    expect(
      toCardFailure('branch_open', 'Branch o/n:x is still open').message
    ).toContain('o/n:x');
  });
});
