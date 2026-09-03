import { formatEntries } from '@workspace/client-core';
import { describe, expect, it } from 'vitest';

import { parseCodexTranscript } from './transcript-parser.js';

// Mirrors the real Codex rollout envelope (verified 2026-07-17): {type,payload,
// timestamp} lines, cwd in session_meta, clean text in event_msg
// user_message/agent_message, noise in response_item/turn_context. Synthetic so
// no real chat content is committed.
const line = (obj: unknown): string => JSON.stringify(obj);

/**
 * A recall call and its answer, with the ENVELOPE AND TOOL FIELDS COPIED
 * VERBATIM from a real rollout (`~/.codex/sessions/2026/07/26/rollout-*.jsonl`,
 * read 2026-07-29) — only the free-text query and the memory content are
 * replaced, so no real chat lands in the repo. The verbatim part is the part
 * that matters: `payload.name` is BARE with the mount in `payload.namespace`,
 * correlation runs on `call_id` (not `id`), and `payload.output` is an array of
 * a STRING — a wall-time banner followed by the serialized text blocks, the
 * tool's own JSON nested and escaped two levels deep inside it. An earlier spec
 * that encoded an unobserved shape is exactly what kept this channel dead on
 * Claude Code for three weeks.
 */
const RECALL_CALL_ID = 'call_mxUAmc1sfoFvLupE1yclHn8e';
const RECALLED_ID = 'mem_4yea92da91x38wav.01kychgcj4';

const RECALL_CALL = line({
  type: 'response_item',
  payload: {
    type: 'function_call',
    name: 'recall',
    namespace: 'mcp__zero_memory',
    arguments: '{"query":"open loops","k":8}',
    call_id: RECALL_CALL_ID,
    id: 'fc_01b43a86b6b91fcb016a65cc6f912081918cb90130fc69496a',
  },
  timestamp: 't7',
});

const RECALL_OUTPUT = line({
  type: 'response_item',
  payload: {
    type: 'function_call_output',
    call_id: RECALL_CALL_ID,
    output: `Wall time: 4.9268 seconds\nOutput:\n${JSON.stringify([
      {
        type: 'text',
        text: JSON.stringify({
          memories: [{ id: RECALLED_ID, content: 'a stored decision' }],
        }),
      },
    ])}`,
  },
  timestamp: 't8',
});

const TRANSCRIPT = [
  line({
    type: 'session_meta',
    payload: { id: 'x', cwd: '/home/u/proj', model_provider: 'openai' },
    timestamp: 't0',
  }),
  line({ type: 'turn_context', payload: { some: 'noise' }, timestamp: 't1' }),
  line({
    type: 'event_msg',
    payload: {
      type: 'user_message',
      message: 'which tasks are open?',
      images: [],
    },
    timestamp: 't2',
  }),
  line({
    type: 'event_msg',
    payload: { type: 'task_started' },
    timestamp: 't3',
  }),
  // response_item message carries developer-role noise — must be skipped.
  line({
    type: 'response_item',
    payload: {
      type: 'message',
      role: 'developer',
      content: [{ type: 'input_text', text: '<permissions instructions> …' }],
    },
    timestamp: 't4',
  }),
  line({
    type: 'event_msg',
    payload: {
      type: 'agent_message',
      message: 'There are 3 open tasks.',
      phase: 'commentary',
    },
    timestamp: 't5',
  }),
  line({
    type: 'event_msg',
    payload: { type: 'token_count' },
    timestamp: 't6',
  }),
].join('\n');

describe('parseCodexTranscript', () => {
  it('extracts event_msg user/assistant text only', () => {
    expect(parseCodexTranscript(TRANSCRIPT).entries).toEqual([
      { role: 'user', text: 'which tasks are open?' },
      { role: 'assistant', text: 'There are 3 open tasks.' },
    ]);
  });

  it('takes cwd from session_meta', () => {
    expect(parseCodexTranscript(TRANSCRIPT).cwd).toBe('/home/u/proj');
  });

  it('surfaces no recalled ids when the slice holds no recall call', () => {
    expect(parseCodexTranscript(TRANSCRIPT).recalledIds).toEqual([]);
  });

  it('renders into the role: text form the extractor consumes', () => {
    expect(formatEntries(parseCodexTranscript(TRANSCRIPT).entries)).toBe(
      [
        'user: which tasks are open?',
        'assistant: There are 3 open tasks.',
      ].join('\n')
    );
  });

  describe('recalled ids', () => {
    it('mines the ids a real recall call surfaced', () => {
      const jsonl = [TRANSCRIPT, RECALL_CALL, RECALL_OUTPUT].join('\n');
      expect(parseCodexTranscript(jsonl).recalledIds).toEqual([RECALLED_ID]);
    });

    it('mines a build_context call the same way', () => {
      const callId = 'call_18U9kPVeL2h2heaBpx4ivZHZ';
      const jsonl = [
        line({
          type: 'response_item',
          payload: {
            type: 'function_call',
            name: 'build_context',
            namespace: 'mcp__zero_memory',
            arguments: '{"topic":"zero-memory","briefing":true}',
            call_id: callId,
          },
        }),
        line({
          type: 'response_item',
          payload: {
            type: 'function_call_output',
            call_id: callId,
            output: `Output:\n${JSON.stringify({ memories: [{ id: RECALLED_ID }] })}`,
          },
        }),
      ].join('\n');
      expect(parseCodexTranscript(jsonl).recalledIds).toEqual([RECALLED_ID]);
    });

    // The whole point of correlating on call_id: a write's result carries a
    // freshly-created id that was never SHOWN to the agent, so counting it
    // would inflate the judge's "shown" set with memories it never read.
    it('ignores the id a remember call created', () => {
      const callId = 'call_W1nlSc8m1UJBSyHVQfQHjost';
      const jsonl = [
        line({
          type: 'response_item',
          payload: {
            type: 'function_call',
            name: 'remember',
            namespace: 'mcp__zero_memory',
            arguments: '{"content":"a new fact"}',
            call_id: callId,
          },
        }),
        line({
          type: 'response_item',
          payload: {
            type: 'function_call_output',
            call_id: callId,
            output: `Output:\n${JSON.stringify({ id: RECALLED_ID })}`,
          },
        }),
      ].join('\n');
      expect(parseCodexTranscript(jsonl).recalledIds).toEqual([]);
    });

    it('ignores an output whose call was never seen in this slice', () => {
      const jsonl = line({
        type: 'response_item',
        payload: {
          type: 'function_call_output',
          call_id: 'call_ORm7Bl2NukCSwGWEFrj76tYh',
          output: `Output:\n${JSON.stringify({ memories: [{ id: RECALLED_ID }] })}`,
        },
      });
      expect(parseCodexTranscript(jsonl).recalledIds).toEqual([]);
    });

    /**
     * The OTHER envelope the same client records an MCP call in, with the
     * fields again COPIED VERBATIM from a real rollout (read 2026-07-30) —
     * `event_msg` rather than `response_item`, an `exec-`-prefixed `call_id`
     * from a different id space, the bare tool name under `invocation.tool`,
     * and the answer on the SAME line under `result.Ok.content`. Only the query
     * and the memory content are replaced. Reading just the first envelope was
     * not losing stray calls: a real session put all seven of its recall and
     * build_context calls here and nowhere else.
     */
    const eventStreamCall = (tool: string, answer: unknown): string =>
      line({
        type: 'event_msg',
        payload: {
          type: 'mcp_tool_call_end',
          call_id: 'exec-29e2c9a3-0e3c-4448-a0a3-141bc728ab1f',
          invocation: {
            server: 'zero-memory',
            tool,
            arguments: { query: 'open loops', k: 8 },
          },
          duration: { secs: 0, nanos: 152447503 },
          result: { Ok: { content: [{ type: 'text', text: line(answer) }] } },
        },
        timestamp: 't9',
      });

    it('mines the ids of a call recorded on the event stream', () => {
      const jsonl = eventStreamCall('recall', {
        memories: [{ id: RECALLED_ID, content: 'a stored decision' }],
      });
      expect(parseCodexTranscript(jsonl).recalledIds).toEqual([RECALLED_ID]);
    });

    it('mines an event-stream build_context the same way', () => {
      const jsonl = eventStreamCall('build_context', {
        memories: [{ id: RECALLED_ID }],
      });
      expect(parseCodexTranscript(jsonl).recalledIds).toEqual([RECALLED_ID]);
    });

    // Same guard as the call_id correlation buys the other envelope: here the
    // tool name sits on the answer's own line, so it is what must be checked.
    it('ignores an event-stream remember result', () => {
      const jsonl = eventStreamCall('remember', { id: RECALLED_ID });
      expect(parseCodexTranscript(jsonl).recalledIds).toEqual([]);
    });

    it('counts a call recorded in both envelopes once', () => {
      const jsonl = [
        RECALL_CALL,
        RECALL_OUTPUT,
        eventStreamCall('recall', { memories: [{ id: RECALLED_ID }] }),
      ].join('\n');
      expect(parseCodexTranscript(jsonl).recalledIds).toEqual([RECALLED_ID]);
    });

    it('surfaces nothing from a failed event-stream call', () => {
      const jsonl = line({
        type: 'event_msg',
        payload: {
          type: 'mcp_tool_call_end',
          call_id: 'exec-62eac856-c870-4183-b657-04254d5ed20f',
          invocation: { server: 'zero-memory', tool: 'recall', arguments: {} },
          duration: { secs: 0, nanos: 258425705 },
          result: { Err: 'request failed' },
        },
      });
      expect(parseCodexTranscript(jsonl).recalledIds).toEqual([]);
    });

    it('keeps mining the conversational text around the tool lines', () => {
      const jsonl = [TRANSCRIPT, RECALL_CALL, RECALL_OUTPUT].join('\n');
      expect(parseCodexTranscript(jsonl).entries).toEqual([
        { role: 'user', text: 'which tasks are open?' },
        { role: 'assistant', text: 'There are 3 open tasks.' },
      ]);
    });
  });

  it('tolerates blank lines and torn JSON', () => {
    const jsonl = [
      '',
      '{not json',
      line({
        type: 'event_msg',
        payload: { type: 'user_message', message: 'hi' },
      }),
    ].join('\n');
    expect(parseCodexTranscript(jsonl).entries).toEqual([
      { role: 'user', text: 'hi' },
    ]);
  });
});
