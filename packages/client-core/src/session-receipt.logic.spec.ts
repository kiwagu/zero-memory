import { describe, expect, it } from 'vitest';

import { formatReceiptLine } from './session-receipt.logic.js';

const zero = {
  captured: 0,
  fired: 0,
  loopsCreated: 0,
  loopsClosed: 0,
  savedTokens: 0,
  alreadyKnew: 0,
};

describe('formatReceiptLine', () => {
  it('is silent when the session produced nothing', () => {
    expect(formatReceiptLine(zero)).toBeNull();
  });

  it('is silent even when only the saved-tokens estimate is non-zero', () => {
    expect(formatReceiptLine({ ...zero, savedTokens: 1200 })).toBeNull();
  });

  it('renders a full session on one line', () => {
    expect(
      formatReceiptLine({
        captured: 3,
        fired: 5,
        loopsCreated: 1,
        loopsClosed: 2,
        savedTokens: 1440,
        alreadyKnew: 2,
      })
    ).toBe(
      '🧾 zero-memory session receipt: captured 3 · 5 recalled facts fired · ' +
        'already knew 2 facts you re-wrote · loops +1/−2 · ~1.4k tokens saved (est.)'
    );
  });

  it('renders the rediscovery signal alone, singular', () => {
    expect(formatReceiptLine({ ...zero, alreadyKnew: 1 })).toBe(
      '🧾 zero-memory session receipt: already knew 1 fact you re-wrote'
    );
  });

  it('renders a capture-only session without empty segments', () => {
    expect(formatReceiptLine({ ...zero, captured: 2 })).toBe(
      '🧾 zero-memory session receipt: captured 2'
    );
  });

  it('renders a read-only session (ingest off) from the fired side alone', () => {
    expect(formatReceiptLine({ ...zero, fired: 1, savedTokens: 400 })).toBe(
      '🧾 zero-memory session receipt: 1 recalled fact fired · ' +
        '~400 tokens saved (est.)'
    );
  });

  it('shows loop churn even when nothing else happened', () => {
    expect(formatReceiptLine({ ...zero, loopsClosed: 2 })).toBe(
      '🧾 zero-memory session receipt: loops +0/−2'
    );
  });
});
