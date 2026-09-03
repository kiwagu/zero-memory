import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  emitPromptDecision,
  emitSessionContext,
  emitToolDecision,
  projectRoot,
} from './hook-io.js';

const captureStdout = () => {
  const lines: string[] = [];
  const spy = vi
    .spyOn(console, 'log')
    .mockImplementation((line: string) => void lines.push(line));
  return { lines, spy };
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('projectRoot', () => {
  it('takes the first workspace root as the project', () => {
    expect(projectRoot({ workspace_roots: ['/a', '/b'] })).toBe('/a');
  });
  it('is undefined when no workspace roots are present', () => {
    expect(projectRoot({})).toBeUndefined();
  });
});

describe('emitSessionContext', () => {
  it('prints the additional_context frame', () => {
    const { lines } = captureStdout();
    emitSessionContext('brief text');
    expect(JSON.parse(lines[0] ?? '')).toEqual({
      additional_context: 'brief text',
    });
  });
});

describe('emitPromptDecision', () => {
  it('defaults to a non-blocking pass-through with no user message', () => {
    const { lines } = captureStdout();
    emitPromptDecision({});
    expect(JSON.parse(lines[0] ?? '')).toEqual({ continue: true });
  });
  it('can block the prompt and show a user message', () => {
    const { lines } = captureStdout();
    emitPromptDecision({ proceed: false, userMessage: 'blocked' });
    expect(JSON.parse(lines[0] ?? '')).toEqual({
      continue: false,
      user_message: 'blocked',
    });
  });
});

describe('emitToolDecision', () => {
  it('allows the tool and carries an agent-facing message by default', () => {
    const { lines } = captureStdout();
    emitToolDecision({ agentMessage: 'recall ZM first' });
    expect(JSON.parse(lines[0] ?? '')).toEqual({
      permission: 'allow',
      agent_message: 'recall ZM first',
    });
  });
  it('can deny a tool', () => {
    const { lines } = captureStdout();
    emitToolDecision({ permission: 'deny' });
    expect(JSON.parse(lines[0] ?? '')).toEqual({ permission: 'deny' });
  });
});
