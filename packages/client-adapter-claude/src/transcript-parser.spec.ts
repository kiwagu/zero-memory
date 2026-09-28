import { describe, expect, it } from 'vitest';

import { parseTranscript } from './transcript-parser.js';

const line = (value: unknown): string => JSON.stringify(value);

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
});
