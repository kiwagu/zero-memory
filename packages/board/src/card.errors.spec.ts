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
    expect(
      toCardFailure('branch_open', 'Branch o/n:x is still open').message
    ).toContain('o/n:x');
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
  // Every state refusal is a `conflict`, whatever its reason: the card exists
  // and the caller may touch it, but its current state refuses this call.
  it.each([
    ['not_found', 'not_found', 'not_found'],
    ['forbidden', 'forbidden', 'forbidden'],
    ['invalid', 'invalid', 'validation_failed'],
    ['kaboom', 'invalid', 'validation_failed'],
    ['branch_required', 'branch_required', 'validation_failed'],
    ['links_required', 'links_required', 'validation_failed'],
    ['archived', 'archived', 'conflict'],
    ['same_state', 'same_state', 'conflict'],
    ['conflict', 'conflict', 'conflict'],
    ['not_attached', 'not_attached', 'conflict'],
    ['already_promoted', 'already_promoted', 'conflict'],
    ['branch_open', 'branch_open', 'conflict'],
    ['not_linked', 'not_linked', 'conflict'],
  ] as const)('reads %s as %s and answers %s', (sent, code, transport) => {
    const failure = toCardFailure(sent);
    expect(failure.code).toBe(code);
    expect(cardFailureToErrorCode(failure)).toBe(transport);
  });
});

describe('the relation rule', () => {
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
