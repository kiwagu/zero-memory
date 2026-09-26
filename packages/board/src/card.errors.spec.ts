import { describe, expect, it } from 'vitest';

import {
  cardFailureToErrorCode,
  isCardFailureCode,
  toCardFailure,
  withLinkCandidates,
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

describe('the relation rule', () => {
  it('maps the relation rule onto the transport vocabulary', () => {
    expect(isCardFailureCode('links_required')).toBe(true);
    expect(cardFailureToErrorCode(toCardFailure('links_required'))).toBe(
      'validation_failed'
    );
    expect(cardFailureToErrorCode(toCardFailure('not_linked'))).toBe(
      'conflict'
    );
  });

  it('names the candidates the store offered, in its order', () => {
    expect(
      withLinkCandidates('Say how this card relates.', [
        {
          id: 'crd_0000000000000007.0000000000',
          number: 7,
          title: 'Search index rebuild',
          state: 'active',
          why: 'mentioned',
        },
        {
          id: 'crd_0000000000000012.0000000000',
          number: 12,
          title: 'Rotate the edge certificates',
          state: 'idea',
          why: 'similar',
        },
      ])
    ).toBe(
      'Say how this card relates. Candidates: ZM-7 "Search index rebuild" ' +
        '[active] (mentioned); ZM-12 "Rotate the edge certificates" [idea] ' +
        '(similar).'
    );
  });

  it('says so when the board offers none', () => {
    expect(withLinkCandidates('Say how.', [])).toBe(
      'Say how. No card on this board looks related.'
    );
  });
});
