import { describe, expect, it } from 'vitest';

import { ConversationChunker, sha256 } from './chunker.js';
import { decodeProjectDir } from './watcher.js';

describe('ConversationChunker', () => {
  it('flushes on the size cap with a stable sha256 hash', () => {
    const chunker = new ConversationChunker({ maxChars: 20, idleMs: 60_000 });

    expect(chunker.append('conv-1', 'user: short')).toEqual([]);
    const [chunk] = chunker.append('conv-1', 'assistant: enough now', [], '/p');

    expect(chunk).toBeDefined();
    expect(chunk!.conversationId).toBe('conv-1');
    expect(chunk!.text).toBe('user: short\nassistant: enough now');
    expect(chunk!.hash).toBe(sha256(chunk!.text));
    expect(chunk!.projectHint).toBe('/p');
    // Buffer is reset after the flush.
    expect(chunker.flushAll()).toEqual([]);
  });

  it('accumulates recalled ids across appends and emits them with the chunk', () => {
    const chunker = new ConversationChunker({ maxChars: 20, idleMs: 60_000 });

    chunker.append('conv-1', 'user: short', ['mem_a']);
    const [chunk] = chunker.append('conv-1', 'assistant: enough now', [
      'mem_b',
      'mem_a',
    ]);

    expect([...chunk!.recalledIds].sort()).toEqual(['mem_a', 'mem_b']);
    // The reseeded/overlap-free buffer starts clean — ids left with the chunk.
    expect(chunker.flushAll()).toEqual([]);
  });

  it('flushes idle conversations only after the idle window', () => {
    let now = 1_000;
    const chunker = new ConversationChunker({
      maxChars: 1_000,
      idleMs: 60_000,
      now: () => now,
    });

    chunker.append('conv-1', 'user: idle text');
    now += 30_000;
    chunker.append('conv-2', 'user: fresh text');

    now += 31_000; // conv-1 idle 61s, conv-2 idle 31s
    const flushed = chunker.flushIdle();

    expect(flushed.map((chunk) => chunk.conversationId)).toEqual(['conv-1']);
  });

  it('keeps conversations isolated', () => {
    const chunker = new ConversationChunker({ maxChars: 15, idleMs: 60_000 });

    chunker.append('a', 'user: aaaa');
    const flushed = chunker.append('b', 'user: bbbbbbbbbbbb');

    expect(flushed.map((chunk) => chunk.conversationId)).toEqual(['b']);
    expect(chunker.flushAll().map((chunk) => chunk.conversationId)).toEqual([
      'a',
    ]);
  });
});

describe('ConversationChunker — overlap', () => {
  it('carries an overlap tail into the next size-flushed chunk', () => {
    const chunker = new ConversationChunker({
      maxChars: 10,
      idleMs: 60_000,
      overlapChars: 6,
    });

    const [first] = chunker.append('c', 'HELLOWORLD'); // size flush
    const [second] = chunker.append('c', 'NEXTPAYLOAD'); // flush with carried tail

    expect(first!.text).toBe('HELLOWORLD');
    // Last 6 chars of the first chunk prefix the second — the boundary context.
    expect(second!.text).toBe('OWORLD\nNEXTPAYLOAD');
    expect(second!.hash).not.toBe(first!.hash);
  });

  it('does not re-send a buffer that holds only carried-over overlap', () => {
    let now = 0;
    const chunker = new ConversationChunker({
      maxChars: 10,
      idleMs: 100,
      overlapChars: 6,
      now: () => now,
    });

    chunker.append('c', 'HELLOWORLD'); // size flush → reseeds 'OWORLD' (no fresh)
    now += 500;

    // The overlap-only buffer is stale (already extracted) → dropped, not sent.
    expect(chunker.flushIdle()).toEqual([]);
  });

  it('idle-flushes fresh content without reseeding overlap', () => {
    let now = 0;
    const chunker = new ConversationChunker({
      maxChars: 1_000,
      idleMs: 100,
      overlapChars: 50,
      now: () => now,
    });

    chunker.append('c', 'user: a durable fact worth keeping');
    now += 200;
    const [chunk] = chunker.flushIdle();
    expect(chunk!.text).toBe('user: a durable fact worth keeping');

    now += 200;
    expect(chunker.flushIdle()).toEqual([]); // no overlap carried on idle
  });

  it('disables overlap when overlapChars is 0 (default behaviour)', () => {
    const chunker = new ConversationChunker({ maxChars: 10, idleMs: 60_000 });

    chunker.append('c', 'HELLOWORLD'); // flush
    const [second] = chunker.append('c', 'NEXTPAYLOAD');

    expect(second!.text).toBe('NEXTPAYLOAD'); // no carried prefix
  });
});

describe('decodeProjectDir', () => {
  it('decodes flattened transcript directory names (best effort)', () => {
    expect(decodeProjectDir('-home-dev-repos-alpha')).toBe(
      '/home/dev/repos/alpha'
    );
    expect(decodeProjectDir('not-flattened')).toBeUndefined();
  });
});
