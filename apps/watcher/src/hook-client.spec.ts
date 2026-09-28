import { Readable } from 'node:stream';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { clientKindFromArgs, hookClient } from './hook-client.js';

/** Feeds `payload` to the hook's stdin, the way the client spawns it. */
const stdinOf = (payload: unknown): void => {
  vi.spyOn(process, 'stdin', 'get').mockReturnValue(
    Readable.from([
      Buffer.from(JSON.stringify(payload)),
    ]) as unknown as typeof process.stdin
  );
};

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

// Codex and Hermes reuse the Claude hook I/O wholesale and swap only their
// transcript parser and provenance label — which is exactly what differs here.
describe.each([
  {
    kind: 'codex' as const,
    provenance: 'codex-stop-hook',
    line: {
      type: 'event_msg',
      payload: { type: 'user_message', message: 'hi from codex' },
    },
    text: 'hi from codex',
  },
  {
    kind: 'hermes' as const,
    provenance: 'hermes-stop-hook',
    line: { type: 'message', role: 'user', text: 'hi from hermes' },
    text: 'hi from hermes',
  },
])('hookClient $kind (reuses the Claude hook I/O)', (client) => {
  it('labels its own ingest provenance', () => {
    expect(hookClient(client.kind).kind).toBe(client.kind);
    expect(hookClient(client.kind).ingestProvenance).toBe(client.provenance);
  });

  it('parses its own transcript format, not the Claude one', () => {
    const line = JSON.stringify(client.line);
    expect(hookClient(client.kind).parse(line).entries).toEqual([
      { role: 'user', text: client.text },
    ]);
    expect(hookClient('claude').parse(line).entries).toEqual([]);
  });

  it('emits the same hookSpecificOutput frame as Claude', () => {
    const out = captureStdout();
    hookClient(client.kind).emitSessionBrief('brief');
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

  it('leaves systemMessage out of the frame when the chat line is empty', () => {
    const out = captureStdout();
    hookClient('claude').emitSessionBrief('brief', '');
    expect(JSON.parse(out[0] ?? '')).toEqual({
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: 'brief',
      },
    });
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

  it('reads a Cursor session’s project from its first workspace root', async () => {
    // Cursor transcripts carry no cwd: the payload's workspace roots stand in.
    stdinOf({
      conversation_id: 'conv-1',
      hook_event_name: 'stop',
      workspace_roots: ['/work/alpha', '/work/beta'],
    });
    expect(await hookClient('cursor').readInput()).toMatchObject({
      sessionId: 'conv-1',
      cwd: '/work/alpha',
      hookEventName: 'stop',
    });
  });

  it('falls back to the process directory when Cursor names no workspace root', async () => {
    stdinOf({ conversation_id: 'conv-2' });
    expect((await hookClient('cursor').readInput()).cwd).toBe(process.cwd());
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
