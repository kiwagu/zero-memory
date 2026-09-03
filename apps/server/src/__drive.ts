import { container } from '@workspace/di';
import {
  GuardedLlmGateway,
  llmGateway,
  type LlmToolCallRequest,
} from '@workspace/llm';
import { BudgetExhaustedError } from '@workspace/policy';

import { register } from './registry/index.js';

register(container);

const request: LlmToolCallRequest = {
  model: 'claude-haiku-4-5-20251001',
  maxOutputTokens: 16,
  system: 'irrelevant',
  prompt: 'irrelevant',
  tool: { name: 'record', description: 'x', inputSchema: { type: 'object' } },
  purpose: 'extraction',
};

const gw = llmGateway();
console.log(
  '1. installed gateway is guarded:',
  gw instanceof GuardedLlmGateway
);

try {
  await gw.callTool(request);
  console.log('2. call was ALLOWED through to the model');
} catch (error) {
  const msg = (error as Error).message;
  console.log(
    error instanceof BudgetExhaustedError
      ? `2. blocked by budget BEFORE the model: ${msg}`
      : `2. reached the model layer instead: ${msg}`
  );
}
