import { afterEach, describe, expect, it, vi } from 'vitest';

import { clientKindFromArgs, hookClient } from './hook-client.js';

const captureStdout = () => {
  const lines: string[] = [];
  vi.spyOn(console, 'log').mockImplementation(
    (line: string) => void lines.push(line)
  );
  return lines;
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('clientKindFromArgs', () => {
  it('reads --client cursor, --client codex and --client hermes', () => {
    expect(clientKindFromArgs(['--client', 'cursor'])).toBe('cursor');
    expect(clientKindFromArgs(['--client', 'codex'])).toBe('codex');
    expect(clientKindFromArgs(['--client', 'hermes'])).toBe('hermes');
  });
  it('defaults to claude when the flag is absent or unknown', () => {
    expect(clientKindFromArgs([])).toBe('claude');
    expect(clientKindFromArgs(['--client', 'claude'])).toBe('claude');
    expect(clientKindFromArgs(['--client', 'wat'])).toBe('claude');
    expect(clientKindFromArgs(['something', 'else'])).toBe('claude');
  });
});

describe('hookClient codex (reuses the Claude hook I/O)', () => {
  it('has its own kind + provenance but Claude-style task-brief', () => {
    const client = hookClient('codex');
    expect(client.kind).toBe('codex');
    expect(client.ingestProvenance).toBe('codex-stop-hook');
    expect(client.canTaskBrief).toBe(true);
  });

  it('parses the Codex rollout format, not the Claude one', () => {
    const codexLine = JSON.stringify({
      type: 'event_msg',
      payload: { type: 'user_message', message: 'hi from codex' },
    });
    expect(hookClient('codex').parse(codexLine).entries).toEqual([
      { role: 'user', text: 'hi from codex' },
    ]);
  });

  it('emits the same hookSpecificOutput frame as Claude', () => {
    const out = captureStdout();
    hookClient('codex').emitSessionBrief('brief');
    expect(JSON.parse(out[0] ?? '')).toEqual({
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: 'brief',
      },
    });
  });
});

describe('hookClient hermes (reuses the Claude hook I/O)', () => {
  it('has its own kind + provenance and can task-brief', () => {
    const client = hookClient('hermes');
    expect(client.kind).toBe('hermes');
    expect(client.ingestProvenance).toBe('hermes-stop-hook');
    expect(client.canTaskBrief).toBe(true);
    // No measured channel into the summarizing model — capture only.
    expect(client.canAnchorCompaction).toBe(false);
  });

  it('parses the Hermes mirror format, not the Claude one', () => {
    const mirrorLine = JSON.stringify({
      type: 'message',
      role: 'user',
      text: 'hi from hermes',
    });
    expect(hookClient('hermes').parse(mirrorLine).entries).toEqual([
      { role: 'user', text: 'hi from hermes' },
    ]);
  });

  it('emits the same hookSpecificOutput frame as Claude', () => {
    const out = captureStdout();
    hookClient('hermes').emitSessionBrief('brief');
    expect(JSON.parse(out[0] ?? '')).toEqual({
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: 'brief',
      },
    });
  });
});

describe('hookClient', () => {
  it('defaults to the Claude adapter', () => {
    const client = hookClient();
    expect(client.kind).toBe('claude');
    expect(client.ingestProvenance).toBe('claude-code-stop-hook');
  });

  it('selects the Cursor adapter and its provenance', () => {
    const client = hookClient('cursor');
    expect(client.kind).toBe('cursor');
    expect(client.ingestProvenance).toBe('cursor-stop-hook');
  });

  it('wires each client to its own transcript parser', () => {
    // A Cursor line (top-level role) parses under cursor, not under claude
    // (which keys on message.role / type).
    const cursorLine = JSON.stringify({
      role: 'user',
      message: { content: [{ type: 'text', text: 'hi from cursor' }] },
    });
    expect(hookClient('cursor').parse(cursorLine).entries).toEqual([
      { role: 'user', text: 'hi from cursor' },
    ]);
    expect(hookClient('claude').parse(cursorLine).entries).toEqual([]);
  });

  it('emits the session brief in each client’s frame format', () => {
    const claudeOut = captureStdout();
    hookClient('claude').emitSessionBrief('brief', 'chat line');
    expect(JSON.parse(claudeOut[0] ?? '')).toEqual({
      systemMessage: 'chat line',
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: 'brief',
      },
    });
    vi.restoreAllMocks();

    const cursorOut = captureStdout();
    // Cursor has no user-visible channel on session start — the chat line drops.
    hookClient('cursor').emitSessionBrief('brief', 'chat line');
    expect(JSON.parse(cursorOut[0] ?? '')).toEqual({
      additional_context: 'brief',
    });
  });

  it('marks task-brief support per client (Cursor cannot inject on prompt)', () => {
    expect(hookClient('claude').canTaskBrief).toBe(true);
    expect(hookClient('cursor').canTaskBrief).toBe(false);
  });

  it('routes turn context through Claude’s single frame for every event', () => {
    const out = captureStdout();
    hookClient('claude').emitTurnContext('PreToolUse', 'nudge');
    expect(JSON.parse(out[0] ?? '')).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        additionalContext: 'nudge',
      },
    });
  });

  it('picks the Cursor channel that each event allows', () => {
    let out = captureStdout();
    hookClient('cursor').emitTurnContext('sessionStart', 'guide');
    expect(JSON.parse(out[0] ?? '')).toEqual({ additional_context: 'guide' });
    vi.restoreAllMocks();

    out = captureStdout();
    hookClient('cursor').emitTurnContext('preToolUse', 'recall first');
    expect(JSON.parse(out[0] ?? '')).toEqual({
      permission: 'allow',
      agent_message: 'recall first',
    });
    vi.restoreAllMocks();

    out = captureStdout();
    hookClient('cursor').emitTurnContext('beforeSubmitPrompt', 'offline');
    expect(JSON.parse(out[0] ?? '')).toEqual({
      continue: true,
      user_message: 'offline',
    });
  });

  it('delivers the receipt on Claude and stays silent on Cursor', () => {
    const claudeOut = captureStdout();
    hookClient('claude').emitReceipt('captured 2');
    expect(JSON.parse(claudeOut[0] ?? '')).toEqual({
      systemMessage: 'captured 2',
    });
    vi.restoreAllMocks();

    const cursorOut = captureStdout();
    hookClient('cursor').emitReceipt('captured 2');
    expect(cursorOut).toEqual([]);
  });
});
