import { describe, expect, it } from 'vitest';

import {
  MAX_PAYLOAD_BYTES,
  MAX_STRING_LENGTH,
  sanitizeCommandPayload,
} from './sanitize.js';

describe('sanitizeCommandPayload', () => {
  it('keeps the facts of a command and only the length of what was written', () => {
    const payload = sanitizeCommandPayload({
      content: 'chose bun over node',
      kind: 'decision',
      scope: 'proj.zm',
    });

    expect(payload).toEqual({
      content: '[content, 19 chars]',
      kind: 'decision',
      scope: 'proj.zm',
    });
  });

  it('redacts every field a person or an agent wrote, wherever it sits', () => {
    const payload = sanitizeCommandPayload({
      verbatim: 'the exact words',
      transcript_chunk: 'a whole conversation',
      title: 'card title',
      body: 'card body',
      text: 'a note',
      reason: 'why it moved',
      entities: [{ name: 'a secret-looking name', type: 'concept' }],
      memory_id: 'mem_a',
      recalled_ids: ['mem_b', 'mem_c'],
    });

    expect(payload).toEqual({
      verbatim: '[content, 15 chars]',
      transcript_chunk: '[content, 20 chars]',
      title: '[content, 10 chars]',
      body: '[content, 9 chars]',
      text: '[content, 6 chars]',
      reason: '[content, 12 chars]',
      entities: [{ name: '[content, 21 chars]', type: 'concept' }],
      memory_id: 'mem_a',
      recalled_ids: ['mem_b', 'mem_c'],
    });
  });

  it('clips long identifier-like fields to the cap and notes how much was dropped', () => {
    const long = 'x'.repeat(MAX_STRING_LENGTH + 200);
    const payload = sanitizeCommandPayload({ label: long });

    const clipped = payload.label as string;
    expect(clipped.startsWith('x'.repeat(MAX_STRING_LENGTH))).toBe(true);
    expect(clipped).toContain('[200 more]');
    expect(clipped.length).toBeLessThan(long.length);
  });

  it('clips strings nested in arrays and objects', () => {
    const long = 'y'.repeat(MAX_STRING_LENGTH + 1);
    const payload = sanitizeCommandPayload({
      tags: [{ label: long, type: 'concept' }],
    });

    const tags = payload.tags as Array<{ label: string }>;
    expect(tags[0]?.label).toContain('[1 more]');
  });

  it('collapses an over-cap payload to a truncation marker with the keys', () => {
    // Many long fields so even after per-field clipping the total exceeds 8 KB.
    const oversized: Record<string, string> = {};
    for (let i = 0; i < 40; i++) {
      oversized[`field_${i}`] = 'z'.repeat(MAX_STRING_LENGTH);
    }

    const payload = sanitizeCommandPayload(oversized);

    expect(payload.truncated).toBe(true);
    expect(payload.command_keys).toEqual(Object.keys(oversized));
    expect(
      Buffer.byteLength(JSON.stringify(oversized), 'utf8')
    ).toBeGreaterThan(MAX_PAYLOAD_BYTES);
  });
});
