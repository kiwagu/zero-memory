import { describe, expect, it } from 'vitest';

import { parseTranscript } from './transcript-parser.js';

const line = (value: unknown): string => JSON.stringify(value);

/** A tool_result content item; `isError` marks a call that did not run. */
const toolResult = (toolUseId: string, content: string, isError?: boolean) => ({
  type: 'tool_result',
  tool_use_id: toolUseId,
  content,
  ...(isError !== undefined && { is_error: isError }),
});

describe('parseTranscript', () => {
  it('keeps user and assistant text and skips tool traffic', () => {
    const jsonl = [
      line({
        type: 'user',
        cwd: '/home/dev/repos/alpha',
        message: { role: 'user', content: 'why did we pick postgres?' },
      }),
      line({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: 'Because of ltree and pgvector.' },
            { type: 'tool_use', id: 't1', name: 'bash', input: { cmd: 'ls' } },
          ],
        },
      }),
      line({
        type: 'user',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 't1',
              // A real id in a non-recall result: grep output, a pasted note.
              content: 'notes/mem_n15ez75g6j96h8bd.01kwwe5nzc.md',
            },
          ],
        },
      }),
      line({ type: 'summary', summary: 'Session about databases' }),
    ].join('\n');

    const parsed = parseTranscript(jsonl);

    expect(parsed.cwd).toBe('/home/dev/repos/alpha');
    expect(parsed.entries).toEqual([
      { role: 'user', text: 'why did we pick postgres?' },
      { role: 'assistant', text: 'Because of ltree and pgvector.' },
    ]);
    // A tool call that is not a recall surfaces nothing to the judge, even
    // when its result happens to carry a memory id.
    expect(parsed.recalledIds).toEqual([]);
  });

  // Regression anchor for the channel that never fired: a client records MCP
  // tools under their NAMESPACED names, so bare names are a shape real
  // transcripts never contain. Matching only those left
  // `recalledIds` permanently empty and the usefulness judge never ran.
  it.each([
    ['plain mcp namespace', 'mcp__zero-memory__'],
    ['plugin-bundled namespace', 'mcp__plugin_zero-memory_zero-memory__'],
  ])('extracts recalled ids under the %s', (_label, prefix) => {
    const hit = 'mem_n15ez75g6j96h8bd.01kwwe5nzc';
    const secondHit = 'mem_yhq467atdvt2v227.01kwpehs1a';
    const createdByRemember = 'mem_1m2dc6apve6x6j0j.01kx3d6d1q';
    const jsonl = [
      line({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'r1',
              name: `${prefix}recall`,
              input: { query: 'x' },
            },
            {
              type: 'tool_use',
              id: 'b1',
              name: `${prefix}build_context`,
              input: { topic: 'y' },
            },
            {
              type: 'tool_use',
              id: 'w1',
              name: `${prefix}remember`,
              input: {},
            },
          ],
        },
      }),
      line({
        type: 'user',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'r1',
              content: `{"memories":[{"id":"${hit}"},{"id":"${secondHit}"}]}`,
            },
            {
              type: 'tool_result',
              tool_use_id: 'w1',
              content: `{"memory_id":"${createdByRemember}"}`,
            },
          ],
        },
      }),
    ].join('\n');

    const parsed = parseTranscript(jsonl);

    expect(parsed.recalledIds).toEqual([hit, secondHit]);
    expect(parsed.recalledIds).not.toContain(createdByRemember);
  });

  it('skips meta lines and empty text', () => {
    const jsonl = [
      line({
        type: 'user',
        isMeta: true,
        message: { role: 'user', content: 'injected context' },
      }),
      line({
        type: 'assistant',
        message: { role: 'assistant', content: '  ' },
      }),
      line({
        type: 'assistant',
        message: { role: 'assistant', content: 'Real answer.' },
      }),
    ].join('\n');

    const parsed = parseTranscript(jsonl);

    expect(parsed.entries).toEqual([
      { role: 'assistant', text: 'Real answer.' },
    ]);
  });

  it('skips the compaction summary, which is recorded as if the user typed it', () => {
    // The shapes here are copied from a real transcript: the boundary is a
    // `system` record (dropped anyway, by type), while the summary that follows
    // is indistinguishable from a human turn except for the flag. Letting it
    // through would feed extraction a machine-written recap of the session
    // labelled as the owner's own words.
    const jsonl = [
      line({
        type: 'user',
        message: { role: 'user', content: 'why did we pick postgres?' },
      }),
      line({ type: 'system', subtype: 'compact_boundary', isMeta: false }),
      line({
        type: 'user',
        isCompactSummary: true,
        message: {
          role: 'user',
          content:
            'This session is being continued from a previous conversation. ' +
            'The owner decided to use postgres.',
        },
      }),
      line({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: 'Picking up where we left off.',
        },
      }),
    ].join('\n');

    const parsed = parseTranscript(jsonl);

    expect(parsed.entries).toEqual([
      { role: 'user', text: 'why did we pick postgres?' },
      { role: 'assistant', text: 'Picking up where we left off.' },
    ]);
  });

  // A PreToolUse denial lands as an error tool_result whose text opens with
  // the hook's reason, so that is the only place a tag counts. The same tag in
  // the call's own input, in prose, or in a compaction recap is talk about a
  // guard, not a refusal.
  it('counts a guard refusal only from a denied tool call', () => {
    const toolUse = JSON.stringify({
      type: 'assistant',
      timestamp: '2026-10-24T10:00:00Z',
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Testing [guard:dev_docs_guard] next.' },
          {
            type: 'tool_use',
            id: 'toolu_1',
            name: 'Bash',
            input: { command: 'echo "[guard:commit_message_guard] refused"' },
          },
        ],
      },
    });
    const refusal = JSON.stringify({
      type: 'user',
      timestamp: '2026-10-24T10:00:01Z',
      message: {
        role: 'user',
        content: [
          toolResult(
            'toolu_1',
            'PreToolUse:Bash hook error: [guard:commit_message_guard] a commit message is one line',
            true
          ),
        ],
      },
    });
    const prose = JSON.stringify({
      type: 'user',
      timestamp: '2026-10-24T10:00:02Z',
      message: {
        role: 'user',
        content: 'plain text mentioning [guard:dev_docs_guard] in prose',
      },
    });
    const recap = JSON.stringify({
      type: 'user',
      isCompactSummary: true,
      timestamp: '2026-10-24T10:00:03Z',
      message: {
        role: 'user',
        content: 'Earlier, [guard:commit_message_guard] refused a commit.',
      },
    });

    expect(
      parseTranscript([toolUse, refusal, prose, recap].join('\n')).guardRefusals
    ).toEqual([{ guard: 'commit_message_guard', at: '2026-10-24T10:00:01Z' }]);
    expect(
      parseTranscript([toolUse, prose, recap].join('\n')).guardRefusals
    ).toEqual([]);
  });

  // A call that SUCCEEDED can still print the tag: reading a guard script,
  // grep or test output over this repository, a recall quoting a stored
  // refusal. And a reason that merely mentions a guard after the hook error
  // is not that guard refusing.
  it('ignores the tag in a successful result or later in the reason', () => {
    const denial =
      'PreToolUse:Bash hook error: [guard:commit_message_guard] a commit message is one line';
    const jsonl = JSON.stringify({
      type: 'user',
      timestamp: '2026-10-24T10:00:04Z',
      message: {
        role: 'user',
        content: [
          toolResult('toolu_2', denial),
          toolResult(
            'toolu_3',
            'PreToolUse:Bash hook error: see [guard:dev_docs_guard]',
            true
          ),
          toolResult(
            'toolu_4',
            'PreToolUse:Bash hook error: [guard:dev_docs_guard] and [guard:commit_message_guard] too',
            true
          ),
        ],
      },
    });

    expect(parseTranscript(jsonl).guardRefusals).toEqual([
      { guard: 'dev_docs_guard', at: '2026-10-24T10:00:04Z' },
    ]);
  });
});
