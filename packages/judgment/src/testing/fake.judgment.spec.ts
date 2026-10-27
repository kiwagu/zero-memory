import { describe, expect, it } from 'vitest';

import { JudgeUnavailableError } from '../judgment.port.js';
import { FakeJudgment } from './fake.judgment.js';

const request = {
  state: {
    task: 'anything',
    rules: {
      r1: { headline: 'A', applies_when: 'tasks that commit [p=0.9]' },
      r2: { headline: 'B', applies_when: 'tasks that deploy' },
      // Not asked about: its marker must not produce an answer.
      r3: { headline: 'C', applies_when: 'tasks that plan [p=0.1]' },
    },
  },
  questions: {
    r1: {
      kind: 'noul' as const,
      instructions: 'binds?',
      criteria: { true: 'y', false: 'n' },
    },
    r2: {
      kind: 'noul' as const,
      instructions: 'binds?',
      criteria: { true: 'y', false: 'n' },
    },
  },
  purpose: 'rule_gate' as const,
  subjectId: null,
};

describe('FakeJudgment', () => {
  it("reads [p=…] markers from the rule of the question's name and defaults otherwise", async () => {
    const result = await new FakeJudgment({ defaultP: 0.5 }).judge(request);
    expect(result.answers.r1?.noul).toBeCloseTo(0.9);
    expect(result.answers.r2?.noul).toBeCloseTo(0.5);
    expect(Object.keys(result.answers).sort()).toEqual(['r1', 'r2']);
    expect(result.provider).toBe('typesafe');
    expect(result.model).toBe('fake');
  });

  it('is unavailable on demand', async () => {
    await expect(
      new FakeJudgment({ mode: 'unavailable' }).judge(request)
    ).rejects.toBeInstanceOf(JudgeUnavailableError);
  });
});
