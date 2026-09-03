import { formatEntries, isRecallTool } from '@workspace/client-core';
import { describe, expect, it } from 'vitest';

import { parseCursorTranscript } from './transcript-parser.js';

/**
 * A recall call COPIED VERBATIM from a real Cursor transcript
 * (`~/.cursor/projects/<slug>/agent-transcripts/<id>/<id>.jsonl`, read
 * 2026-07-29) apart from the query text. Every field is the record's own: the
 * call hides behind `name: "CallDynamicTool"` with the real tool in
 * `input.toolName`, and the block carries NO id — `type`, `name`, `input` are
 * its only keys, which is precisely why a result could never be correlated
 * back to it.
 */
const REAL_RECALL_CALL = {
  type: 'tool_use',
  name: 'CallDynamicTool',
  input: {
    namespace: 'user-zero-memory',
    toolName: 'recall',
    arguments: { query: 'open loops awaiting an answer', limit: 10 },
  },
} as const;

// Mirrors the real Cursor envelope (verified 2026-07-17): top-level `role`,
// user text wrapped in <timestamp>/<user_query>, assistant reasoning stripped
// to [REDACTED], tool_use calls with no inline results, a turn_ended control
// line. Kept synthetic so no real chat content is committed.
const line = (obj: unknown): string => JSON.stringify(obj);

const TRANSCRIPT = [
  line({
    role: 'user',
    message: {
      content: [
        {
          type: 'text',
          text: '<timestamp>Friday, Jul 17, 2026, 4:52 PM (UTC+2)</timestamp>\n<user_query>\nWhich tasks are open in ZM?\n</user_query>',
        },
      ],
    },
  }),
  line({
    role: 'assistant',
    message: {
      content: [
        {
          type: 'text',
          text: 'Checking zero-memory for open tasks.\n\n[REDACTED]',
        },
        {
          type: 'tool_use',
          name: 'CallDynamicTool',
          input: {
            namespace: 'user-zero-memory',
            toolName: 'build_context',
            arguments: { topic: 'open tasks', briefing: true },
          },
        },
      ],
    },
  }),
  // A pure-reasoning turn: only [REDACTED] + a tool call → contributes no text.
  line({
    role: 'assistant',
    message: {
      content: [
        { type: 'text', text: '[REDACTED]' },
        { type: 'tool_use', name: 'Read', input: { path: '/tmp/x.txt' } },
      ],
    },
  }),
  line({
    role: 'assistant',
    message: {
      content: [
        { type: 'text', text: 'There are 3 open tasks.\n\n[REDACTED]' },
      ],
    },
  }),
  line({ type: 'turn_ended', status: 'success' }),
].join('\n');

describe('parseCursorTranscript', () => {
  it('extracts user query and assistant text, unwrapping and stripping', () => {
    const parsed = parseCursorTranscript(TRANSCRIPT);
    expect(parsed.entries).toEqual([
      { role: 'user', text: 'Which tasks are open in ZM?' },
      { role: 'assistant', text: 'Checking zero-memory for open tasks.' },
      { role: 'assistant', text: 'There are 3 open tasks.' },
    ]);
  });

  it('never surfaces recalled ids (Cursor does not inline tool results)', () => {
    expect(parseCursorTranscript(TRANSCRIPT).recalledIds).toEqual([]);
  });

  // Pins WHERE the judge channel breaks on Cursor, so a future attempt starts
  // from the real obstacle instead of re-deriving it. Naming is not the
  // obstacle — the shared matcher recognizes the recorded tool name fine; the
  // result simply never reaches the transcript, and the call carries no id to
  // correlate one by.
  describe('the judge-channel gap', () => {
    it('recognizes the recall call the shared matcher is given', () => {
      expect(isRecallTool(REAL_RECALL_CALL.input.toolName)).toBe(true);
    });

    it('has no id on the call to correlate a result by', () => {
      expect(Object.keys(REAL_RECALL_CALL).sort()).toEqual([
        'input',
        'name',
        'type',
      ]);
    });

    it('yields no recalled ids even when the slice holds a real recall call', () => {
      const jsonl = line({
        role: 'assistant',
        message: {
          content: [
            { type: 'text', text: 'Checking memory.' },
            REAL_RECALL_CALL,
          ],
        },
      });
      const parsed = parseCursorTranscript(jsonl);
      expect(parsed.entries).toEqual([
        { role: 'assistant', text: 'Checking memory.' },
      ]);
      expect(parsed.recalledIds).toEqual([]);
    });
  });

  it('leaves cwd undefined (supplied by the hook payload, not the transcript)', () => {
    expect(parseCursorTranscript(TRANSCRIPT).cwd).toBeUndefined();
  });

  it('renders into the role: text form the extractor consumes', () => {
    expect(formatEntries(parseCursorTranscript(TRANSCRIPT).entries)).toBe(
      [
        'user: Which tasks are open in ZM?',
        'assistant: Checking zero-memory for open tasks.',
        'assistant: There are 3 open tasks.',
      ].join('\n')
    );
  });

  it('tolerates string content, blank lines, and torn JSON', () => {
    const jsonl = [
      '',
      line({ role: 'user', message: { content: 'plain string body' } }),
      '{not json',
      line({
        role: 'assistant',
        message: { content: [{ type: 'text', text: 'ok' }] },
      }),
    ].join('\n');
    expect(parseCursorTranscript(jsonl).entries).toEqual([
      { role: 'user', text: 'plain string body' },
      { role: 'assistant', text: 'ok' },
    ]);
  });

  it('skips a user turn that is only the wrapper with an empty query', () => {
    const jsonl = line({
      role: 'user',
      message: {
        content: [
          {
            type: 'text',
            text: '<timestamp>now</timestamp>\n<user_query>\n\n</user_query>',
          },
        ],
      },
    });
    expect(parseCursorTranscript(jsonl).entries).toEqual([]);
  });
});
