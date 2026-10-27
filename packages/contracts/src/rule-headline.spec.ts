import { describe, expect, it } from 'vitest';

import { ruleHeadline } from './rule-headline.js';

describe('ruleHeadline', () => {
  it('cuts at the first sentence break outside parentheses, after 20 chars', () => {
    expect(
      ruleHeadline(
        'ONE-LINE COMMITS (every project, e.g. this one). The subject names the goal…'
      )
    ).toBe('ONE-LINE COMMITS (every project, e.g. this one)');
  });

  it('ends at a spaced dash or a full stop as well', () => {
    expect(
      ruleHeadline(
        'ONE-LINE COMMITS (every project) — the subject names the goal, ' +
          'never the mechanics.'
      )
    ).toBe('ONE-LINE COMMITS (every project)');
    expect(ruleHeadline('Release builds are always SIGNED. Always.')).toBe(
      'Release builds are always SIGNED'
    );
  });

  it('does not break inside an open parenthesis', () => {
    expect(
      ruleHeadline(
        'STYLE GUIDE FIRST (read it — not only when asked): the rest follows.'
      )
    ).toBe('STYLE GUIDE FIRST (read it — not only when asked)');
  });

  it('caps at 160 characters with an ellipsis', () => {
    expect(ruleHeadline('A'.repeat(200)).length).toBe(161);
    expect(ruleHeadline('A'.repeat(200)).endsWith('…')).toBe(true);
  });
});
