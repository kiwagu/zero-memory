import { describe, expect, it } from 'vitest';

import { ruleHeadline } from './rule-headline.js';

describe('ruleHeadline', () => {
  it('cuts at the first sentence break outside parentheses, after 20 chars', () => {
    expect(
      ruleHeadline(
        'NO PRIVATE REFERENCES IN COMMITTED ARTIFACTS (every project; owner 2026-10-12). Anything committed must…'
      )
    ).toBe(
      'NO PRIVATE REFERENCES IN COMMITTED ARTIFACTS (every project; owner 2026-10-12)'
    );
  });

  it('ends at a spaced dash or a full stop as well', () => {
    expect(
      ruleHeadline(
        'NO PRIVATE REFERENCES IN COMMITTED ARTIFACTS (every project) — the ' +
          'rest explains why.'
      )
    ).toBe('NO PRIVATE REFERENCES IN COMMITTED ARTIFACTS (every project)');
    expect(ruleHeadline('Production systems are READ-ONLY. Always.')).toBe(
      'Production systems are READ-ONLY'
    );
  });

  it('does not break inside an open parenthesis', () => {
    expect(
      ruleHeadline(
        'NORTH STAR (keep it in view — not only when asked): the rest follows.'
      )
    ).toBe('NORTH STAR (keep it in view — not only when asked)');
  });

  it('caps at 160 characters with an ellipsis', () => {
    expect(ruleHeadline('A'.repeat(200)).length).toBe(161);
    expect(ruleHeadline('A'.repeat(200)).endsWith('…')).toBe(true);
  });
});
