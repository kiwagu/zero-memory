import { describe, expect, it } from 'vitest';

import { JudgeUnavailableError } from '../judgment.port.js';
import { FakeJudgment } from './fake.judgment.js';

const request = {
  state: {
    task: 'anything',
    rules: {
      rlc_a: { headline: 'A', applies_when: 'tasks that commit [p=0.9]' },
      rlc_b: { headline: 'B', applies_when: 'tasks that deploy' },
      // Not asked about: its marker must not produce an answer.
      rlc_c: { headline: 'C', applies_when: 'tasks that plan [p=0.1]' },
    },
  },
  questions: {
    rule_rlc_a: {
      kind: 'noul' as const,
      instructions: 'binds?',
      criteria: { true: 'y', false: 'n' },
    },
    rule_rlc_b: {
      kind: 'noul' as const,
      instructions: 'binds?',
      criteria: { true: 'y', false: 'n' },
    },
  },
  purpose: 'rule_gate' as const,
  subjectId: null,
};

describe('FakeJudgment', () => {
  it('reads [p=…] markers from the rule the question names and defaults otherwise', async () => {
    const result = await new FakeJudgment({ defaultP: 0.5 }).judge(request);
    expect(result.answers.rule_rlc_a?.noul).toBeCloseTo(0.9);
    expect(result.answers.rule_rlc_b?.noul).toBeCloseTo(0.5);
    expect(Object.keys(result.answers).sort()).toEqual([
      'rule_rlc_a',
      'rule_rlc_b',
    ]);
    expect(result.provider).toBe('typesafe');
    expect(result.model).toBe('fake');
  });

  it('is unavailable on demand', async () => {
    await expect(
      new FakeJudgment({ mode: 'unavailable' }).judge(request)
    ).rejects.toBeInstanceOf(JudgeUnavailableError);
  });
});
