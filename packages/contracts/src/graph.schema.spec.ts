import { describe, expect, it } from 'vitest';

import { contextRuleSchema, ruleCandidateIdSchema } from './graph.schema.js';

/** A well-formed id body: 16 Crockford characters, a dot, 10 more. */
const ID_BODY = '0123456789abcdfh.0123456789';

describe('contextRuleSchema', () => {
  it('still parses the legacy shape', () => {
    expect(
      contextRuleSchema.parse({ text: 'Always X.', pinned: false })
    ).toEqual({ text: 'Always X.', pinned: false });
  });

  it('accepts id, headline, applies_when and level', () => {
    const rule = contextRuleSchema.parse({
      text: 'ALWAYS X',
      pinned: false,
      id: `rlc_${ID_BODY}`,
      headline: 'ALWAYS X',
      applies_when: 'tasks that commit',
      level: 'headline',
    });
    expect(rule.level).toBe('headline');
  });

  it('refuses an unknown level and a non-rule id', () => {
    expect(
      contextRuleSchema.safeParse({ text: 't', pinned: false, level: 'short' })
        .success
    ).toBe(false);
    expect(ruleCandidateIdSchema.safeParse(`mem_${ID_BODY}`).success).toBe(
      false
    );
  });
});
