import { setLlmGateway } from '@workspace/llm';
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
};

describe('AppliesWhenDrafter', () => {
  it('returns the drafted condition and the model that wrote it', async () => {
    answering({ applies_when: '  any task that changes migrations\n' });

    const draft = await new AppliesWhenDrafter().draft(RULE);

    expect(draft).toEqual({
      applies_when: 'any task that changes migrations',
      model: 'a-model',
    });
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
