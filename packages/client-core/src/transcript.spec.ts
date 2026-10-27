import { describe, expect, it } from 'vitest';

import { formatEntries, parseJsonLines } from './transcript.js';

/** A schema that accepts `{ n: number }` records only. */
const numbered = {
  safeParse: (value: unknown) =>
    typeof (value as { n?: unknown } | null)?.n === 'number'
      ? { success: true as const, data: value as { n: number } }
      : { success: false as const },
};

describe('parseJsonLines', () => {
  it('keeps the records a slice read from mid-file can still yield, in order', () => {
    // A slice starts at a byte offset: its first line may be torn, its last
    // half-written, and some lines belong to shapes the parser does not read.
    const jsonl = [
      '1}, "torn": true}',
      '{"n": 1}',
      '',
      '   ',
      '{"other": "shape"}',
      '  {"n": 2}  ',
      'not json at all',
      '{"n": 3, "extra": "kept"}',
      '{"n": 4, "half": "writ',
    ].join('\n');

    expect(parseJsonLines(jsonl, numbered)).toEqual([
      { n: 1 },
      { n: 2 },
      { n: 3, extra: 'kept' },
    ]);
  });
});

describe('formatEntries', () => {
  it('renders role-prefixed lines', () => {
    expect(
      formatEntries([
        { role: 'user', text: 'hi' },
        { role: 'assistant', text: 'hello' },
      ])
    ).toBe('user: hi\nassistant: hello');
  });
});
