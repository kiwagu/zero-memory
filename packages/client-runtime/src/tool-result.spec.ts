import { describe, expect, it } from 'vitest';

import { parseToolPayload, toolTextBlocks } from './tool-result.js';

/** The server's asToolResult shape: JSON payload block + optional note blocks. */
const asResult = (payload: unknown, ...notes: string[]) => ({
  content: [
    { type: 'text', text: JSON.stringify(payload, null, 2) },
    ...notes.map((text) => ({ type: 'text' as const, text })),
  ],
});

describe('parseToolPayload', () => {
  it('parses the first block even when a project-rules note block follows', () => {
    // The exact regression: a note block ("PROJECT RULES …\n\n--- reminder ---")
    // trails the JSON. The old join-then-split('\n---') sliced across blocks and
    // fed invalid JSON to the parser; parsing the first block alone is correct.
    const payload = { memories: [{ id: 'mem_1' }], open_loops_total: 2 };
    const result = asResult(
      payload,
      "PROJECT RULES — standing instructions the owner promoted for THIS project's " +
        'sessions:\n1. Do the thing\n\n--- reminder --- call remember now.'
    );
    expect(parseToolPayload(result)).toEqual(payload);
  });

  it('parses a payload whose memory body itself contains a --- rule', () => {
    // A markdown horizontal rule inside a memory's content must never be mistaken
    // for a block delimiter — it lives INSIDE the JSON string.
    const payload = {
      memories: [{ id: 'mem_2', content: 'step one\n---\nstep two' }],
    };
    expect(parseToolPayload(asResult(payload))).toEqual(payload);
  });

  it('throws when the result has no text content', () => {
    expect(() => parseToolPayload({ content: [] })).toThrow(/no text content/);
    expect(() => parseToolPayload({})).toThrow(/no text content/);
  });
});

describe('toolTextBlocks', () => {
  it('returns text blocks in order and drops non-text blocks', () => {
    const result = {
      content: [
        { type: 'text', text: 'a' },
        { type: 'image', data: 'xxx' },
        { type: 'text', text: 'b' },
      ],
    };
    expect(toolTextBlocks(result)).toEqual(['a', 'b']);
  });
});
