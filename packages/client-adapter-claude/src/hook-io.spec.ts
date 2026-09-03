import { afterEach, describe, expect, it, vi } from 'vitest';

import { emitHookContext, emitSystemMessage } from './hook-io.js';

afterEach(() => {
  vi.restoreAllMocks();
});

const captureLog = (): (() => string[]) => {
  const lines: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((arg: unknown) => {
    lines.push(String(arg));
  });
  return () => lines;
};

describe('emitHookContext', () => {
  it('prints the hookSpecificOutput frame (context only)', () => {
    const lines = captureLog();
    emitHookContext('SessionStart', 'the briefing body');
    expect(JSON.parse(lines()[0] ?? '')).toEqual({
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: 'the briefing body',
      },
    });
  });

  it('rides a user-facing systemMessage in the same frame, systemMessage first', () => {
    const lines = captureLog();
    emitHookContext('SessionStart', 'context', 'a chat-visible notice');
    // systemMessage key precedes hookSpecificOutput (insertion order is wire order).
    expect(lines()[0]).toBe(
      '{"systemMessage":"a chat-visible notice",' +
        '"hookSpecificOutput":{"hookEventName":"SessionStart",' +
        '"additionalContext":"context"}}'
    );
  });

  it('omits systemMessage when empty', () => {
    const lines = captureLog();
    emitHookContext('UserPromptSubmit', 'ctx', '');
    expect(JSON.parse(lines()[0] ?? '')).not.toHaveProperty('systemMessage');
  });
});

describe('emitSystemMessage', () => {
  it('prints a systemMessage-only frame (no hookSpecificOutput)', () => {
    const lines = captureLog();
    emitSystemMessage('the session receipt line');
    expect(lines()[0]).toBe('{"systemMessage":"the session receipt line"}');
  });
});
