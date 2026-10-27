import { ruleCandidateIdSchema } from '@workspace/contracts';
import { describe, expect, it } from 'vitest';

import { renderRulesFooter } from './rules-footer.js';

describe('renderRulesFooter', () => {
  it('renders full, gate and headline levels and points at the one-rule resource', () => {
    const footer = renderRulesFooter([
      {
        id: ruleCandidateIdSchema.parse('rlc_0000000000000000.0000000000'),
        text: 'PINNED. Whole text.',
        pinned: true,
        level: 'full',
      },
      {
        id: ruleCandidateIdSchema.parse('rlc_1111111111111111.1111111111'),
        text: 'GATED',
        pinned: false,
        level: 'gate',
        applies_when: 'tasks that deploy',
      },
      {
        id: ruleCandidateIdSchema.parse('rlc_2222222222222222.2222222222'),
        text: 'NAMED ONLY',
        pinned: false,
        level: 'headline',
      },
    ]);
    expect(footer).toContain('1. [pinned] PINNED. Whole text.\n');
    expect(footer).not.toContain('rlc_0000000000000000.0000000000');
    expect(footer).toContain(
      '2. GATED — applies when: tasks that deploy [gate] rlc_1111111111111111.1111111111'
    );
    expect(footer).toContain(
      '3. NAMED ONLY [headline] rlc_2222222222222222.2222222222'
    );
    expect(footer).toContain('zm://rules/<id>');
    expect(footer).toContain('2 rule(s)');
    expect(footer).toContain('may not bind this task');
  });
  it('names a gate rule with no condition without an empty one', () => {
    const footer = renderRulesFooter([
      {
        id: ruleCandidateIdSchema.parse('rlc_1111111111111111.1111111111'),
        text: 'GATED',
        pinned: false,
        level: 'gate',
      },
    ]);
    expect(footer).toContain('1. GATED [gate] rlc_1111111111111111.1111111111');
    expect(footer).not.toContain('applies when');
  });
  it('renders legacy rules (no level) whole with no footer note', () => {
    const footer = renderRulesFooter([{ text: 'WHOLE. Text.', pinned: false }]);
    expect(footer).toContain('1. WHOLE. Text.');
    expect(footer).not.toContain('zm://rules/<id>');
  });
});
