import { setLlmGateway, type LlmToolCallRequest } from '@workspace/llm';
import { describe, expect, it, vi } from 'vitest';

import { AppliesWhenDrafter } from './applies-when.drafter.js';

const RULE = 'Keep migrations forward-only. Never edit an applied one.';

/** Installs a gateway whose tool call answers with `input`. */
const answering = (input: unknown) => {
  const callTool = vi.fn().mockResolvedValue({
    input,
    model: 'a-model',
    inputTokens: 80,
    outputTokens: 12,
    ranOnCallerKey: false,
  });
  setLlmGateway({ callTool, searchWeb: vi.fn() });
  return callTool;
};

const OWNER = 'usr_000000000000000a.0000000000';

describe('AppliesWhenDrafter', () => {
  it('returns the drafted condition and the model that wrote it', async () => {
    answering({ applies_when: '  any task that changes migrations\n' });

    const draft = await new AppliesWhenDrafter().draft(RULE);

    expect(draft).toEqual({
      applies_when: 'any task that changes migrations',
      model: 'a-model',
    });
  });

  it("meters the call as rule distillation on the owner's account when one is named", async () => {
    const callTool = answering({ applies_when: null });

    await new AppliesWhenDrafter().draft(RULE, OWNER);
    await new AppliesWhenDrafter().draft(RULE);

    const [owned, unowned] = callTool.mock.calls.map(
      (call) => call[0] as LlmToolCallRequest
    );
    expect(owned).toMatchObject({
      purpose: 'rule_distiller',
      subjectId: OWNER,
    });
    expect(unowned).toMatchObject({ purpose: 'rule_distiller' });
    expect(unowned).not.toHaveProperty('subjectId');
  });

  it('returns null when the rule binds every task', async () => {
    answering({ applies_when: null });

    const draft = await new AppliesWhenDrafter().draft(RULE);

    expect(draft.applies_when).toBeNull();
  });

  it('rejects a condition longer than 400 characters', async () => {
    answering({ applies_when: 'x'.repeat(401) });

    await expect(new AppliesWhenDrafter().draft(RULE)).rejects.toThrow();
  });
});
