import { describe, expect, it } from 'vitest';

import { parseHermesTranscript } from './transcript-parser.js';

/**
 * The mirror format is a contract between the Hermes plugin (writer) and this
 * parser (reader), both living in this repository — so these tests are the
 * place that contract is pinned. They are written against the exact lines the
 * plugin emits; changing one side without the other must turn a test red.
 */
const line = (value: Record<string, unknown>): string => JSON.stringify(value);

describe('parseHermesTranscript', () => {
  it('reads the conversational stream and the header cwd', () => {
    const jsonl = [
      line({
        type: 'session',
        session_id: 'ses_1',
        cwd: '/home/dev/project',
      }),
      line({ type: 'message', role: 'user', text: 'add retries' }),
      line({ type: 'message', role: 'assistant', text: 'done' }),
    ].join('\n');

    expect(parseHermesTranscript(jsonl)).toEqual({
      entries: [
        { role: 'user', text: 'add retries' },
        { role: 'assistant', text: 'done' },
      ],
      cwd: '/home/dev/project',
      recalledIds: [],
    });
  });

  it('collects mem_ ids from recall results — the judge channel', () => {
    const jsonl = [
      line({ type: 'message', role: 'user', text: 'why this way?' }),
      line({
        type: 'tool_result',
        tool: 'mcp__zero-memory__recall',
        result: {
          memories: [
            { id: 'mem_w0fy6g43fawks08e.01m02cghyr' },
            { id: 'mem_2mf6fcmdvpw7ptka.01kxgg21w3' },
          ],
        },
      }),
    ].join('\n');

    const parsed = parseHermesTranscript(jsonl);

    expect(parsed.recalledIds).toEqual([
      'mem_w0fy6g43fawks08e.01m02cghyr',
      'mem_2mf6fcmdvpw7ptka.01kxgg21w3',
    ]);
    // A tool_result line is never conversation.
    expect(parsed.entries).toEqual([{ role: 'user', text: 'why this way?' }]);
  });

  it('ignores ids from a write tool, so a fresh id is not scored as recalled', () => {
    const jsonl = line({
      type: 'tool_result',
      tool: 'mcp__zero-memory__remember',
      result: { id: 'mem_w0fy6g43fawks08e.01m02cghyr' },
    });

    expect(parseHermesTranscript(jsonl).recalledIds).toEqual([]);
  });

  it('matches a recall tool under any mount prefix, bare included', () => {
    const jsonl = [
      line({
        type: 'tool_result',
        tool: 'build_context',
        result: 'mem_w0fy6g43fawks08e.01m02cghyr',
      }),
      line({
        type: 'tool_result',
        tool: 'mcp__zero_memory__recall',
        result: 'mem_2mf6fcmdvpw7ptka.01kxgg21w3',
      }),
    ].join('\n');

    expect(parseHermesTranscript(jsonl).recalledIds).toEqual([
      'mem_w0fy6g43fawks08e.01m02cghyr',
      'mem_2mf6fcmdvpw7ptka.01kxgg21w3',
    ]);
  });

  it('survives a slice that starts mid-file: no header, torn first line', () => {
    const jsonl = [
      '{"type":"message","role":"user","te',
      line({ type: 'message', role: 'assistant', text: 'still parsed' }),
    ].join('\n');

    expect(parseHermesTranscript(jsonl)).toEqual({
      entries: [{ role: 'assistant', text: 'still parsed' }],
      cwd: undefined,
      recalledIds: [],
    });
  });

  it('skips non-conversational roles, empty text, and unknown line types', () => {
    const jsonl = [
      line({ type: 'message', role: 'system', text: 'you are an agent' }),
      line({ type: 'message', role: 'assistant', text: '   ' }),
      line({ type: 'telemetry', role: 'user', text: 'not conversation' }),
      line({ type: 'message', role: 'user', text: 'kept' }),
    ].join('\n');

    expect(parseHermesTranscript(jsonl).entries).toEqual([
      { role: 'user', text: 'kept' },
    ]);
  });

  it('deduplicates ids surfaced by more than one recall', () => {
    const jsonl = [
      line({
        type: 'tool_result',
        tool: 'recall',
        result: 'mem_w0fy6g43fawks08e.01m02cghyr',
      }),
      line({
        type: 'tool_result',
        tool: 'build_context',
        result: 'mem_w0fy6g43fawks08e.01m02cghyr',
      }),
    ].join('\n');

    expect(parseHermesTranscript(jsonl).recalledIds).toEqual([
      'mem_w0fy6g43fawks08e.01m02cghyr',
    ]);
  });

  it('returns an empty transcript for an empty slice', () => {
    expect(parseHermesTranscript('')).toEqual({
      entries: [],
      cwd: undefined,
      recalledIds: [],
    });
  });
});
