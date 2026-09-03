import { describe, expect, it } from 'vitest';

import {
  MAX_PAYLOAD_BYTES,
  MAX_STRING_LENGTH,
  sanitizeCommandPayload,
} from './sanitize.js';

describe('sanitizeCommandPayload', () => {
  it('keeps small payloads intact', () => {
    const payload = sanitizeCommandPayload({
      content: 'chose bun over node',
      kind: 'decision',
      scope: 'proj.zm',
    });

    expect(payload).toEqual({
      content: 'chose bun over node',
      kind: 'decision',
      scope: 'proj.zm',
    });
  });

  it('clips long string fields to the cap and notes how much was dropped', () => {
    const long = 'x'.repeat(MAX_STRING_LENGTH + 200);
    const payload = sanitizeCommandPayload({ content: long });

    const clipped = payload.content as string;
    expect(clipped.startsWith('x'.repeat(MAX_STRING_LENGTH))).toBe(true);
    expect(clipped).toContain('[200 more]');
    expect(clipped.length).toBeLessThan(long.length);
  });

  it('clips strings nested in arrays and objects', () => {
    const long = 'y'.repeat(MAX_STRING_LENGTH + 1);
    const payload = sanitizeCommandPayload({
      entities: [{ name: long, type: 'concept' }],
    });

    const entities = payload.entities as Array<{ name: string }>;
    expect(entities[0]?.name).toContain('[1 more]');
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
