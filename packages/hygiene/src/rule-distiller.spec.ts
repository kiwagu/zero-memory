import { setLlmGateway, type LlmToolCallRequest } from '@workspace/llm';
import { describe, expect, it, vi } from 'vitest';

import { RuleDistiller } from './rule-distiller.js';

const OWNER = 'usr_000000000000000a.0000000000';

describe('RuleDistiller', () => {
  it('asks for applies_when and returns it on the verdict', async () => {
    const callTool = vi.fn().mockResolvedValue({
      input: {
        rule: true,
        rule_text: 'Always run the commit guard before committing.',
        applies_when: 'any task that commits to git',
        confidence: 0.9,
        rationale: 'standing convention',
      },
      model: 'a-model',
      inputTokens: 100,
      outputTokens: 20,
      ranOnCallerKey: false,
    });
    setLlmGateway({ callTool, searchWeb: vi.fn() });

    const judgement = await new RuleDistiller().distill(
      {
        id: 'mem_0000000000000001.0000000000',
        kind: 'convention',
        scope: 'user.usr_000000000000000a_0000000000',
        content: 'run the commit guard before every commit',
      },
      [],
      [],
      OWNER
    );

    const request = callTool.mock.calls[0]![0] as LlmToolCallRequest;
    const properties = request.tool.inputSchema['properties'] as Record<
      string,
      unknown
    >;
    expect(properties).toHaveProperty('applies_when');
    expect(judgement.verdict.applies_when).toBe('any task that commits to git');
  });
});
