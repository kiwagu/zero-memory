import { afterEach, describe, expect, it } from 'vitest';

import {
  assessCandidate,
  assessChunk,
  MIN_SIGNAL_CHARS,
  NOISY_KIND_CONFIDENCE,
  resolveExtractionEnabled,
  resolveGateMode,
  substantiveLength,
} from './extraction-gate.js';
import type { ExtractedMemory } from './extraction.schema.js';

const candidate = (over: Partial<ExtractedMemory> = {}): ExtractedMemory => ({
  content: 'a durable statement about something',
  kind: 'fact',
  confidence: 0.9,
  portable: false,
  entities: [],
  relations: [],
  ...over,
});

describe('resolveGateMode', () => {
  const prev = process.env.ZM_INGEST_GATE;
  afterEach(() => {
    if (prev === undefined) delete process.env.ZM_INGEST_GATE;
    else process.env.ZM_INGEST_GATE = prev;
  });

  it('defaults to off and normalizes unknown values to off', () => {
    delete process.env.ZM_INGEST_GATE;
    expect(resolveGateMode()).toBe('off');
    process.env.ZM_INGEST_GATE = 'nonsense';
    expect(resolveGateMode()).toBe('off');
  });

  it('honors enforce and shadow (case-insensitive)', () => {
    process.env.ZM_INGEST_GATE = 'ENFORCE';
    expect(resolveGateMode()).toBe('enforce');
    process.env.ZM_INGEST_GATE = 'Shadow';
    expect(resolveGateMode()).toBe('shadow');
  });
});

describe('resolveExtractionEnabled', () => {
  const prev = process.env.ZM_INGEST_EXTRACT;
  afterEach(() => {
    if (prev === undefined) delete process.env.ZM_INGEST_EXTRACT;
    else process.env.ZM_INGEST_EXTRACT = prev;
  });

  it('defaults to off (metrics-only is the standing posture)', () => {
    delete process.env.ZM_INGEST_EXTRACT;
    expect(resolveExtractionEnabled()).toBe(false);
  });

  it('is off for off/false/0/no (case-insensitive)', () => {
    for (const value of ['off', 'FALSE', '0', 'No']) {
      process.env.ZM_INGEST_EXTRACT = value;
      expect(resolveExtractionEnabled()).toBe(false);
    }
  });

  it('is on only when explicitly enabled', () => {
    process.env.ZM_INGEST_EXTRACT = 'on';
    expect(resolveExtractionEnabled()).toBe(true);
  });
});

describe('substantiveLength', () => {
  it('strips role prefixes and collapses whitespace', () => {
    expect(substantiveLength('user: ok\nassistant: done')).toBe(
      'ok done'.length
    );
  });
});

describe('assessChunk (part A: pre-extraction)', () => {
  it('skips an acknowledgement-only exchange', () => {
    const verdict = assessChunk(
      'user: はい、お願いします\nassistant: 完了しました。'
    );
    expect(verdict.extract).toBe(false);
    expect(verdict.reason).toBe('no-signal');
  });

  it('passes a terse but real note just over the floor', () => {
    const note =
      'user: baz fails from the wrong cwd, always use an absolute path';
    expect(substantiveLength(note)).toBeGreaterThanOrEqual(MIN_SIGNAL_CHARS);
    expect(assessChunk(note).extract).toBe(true);
  });

  it('passes a long substantive turn', () => {
    expect(
      assessChunk(
        'assistant: We chose Postgres over MySQL because ltree gives us ' +
          'native hierarchical scope paths without a recursive CTE.'
      ).extract
    ).toBe(true);
  });
});

describe('assessCandidate (part B: post-extraction kind bar)', () => {
  it('drops a low-confidence fact on the transcript path', () => {
    const verdict = assessCandidate(
      candidate({ kind: 'fact', confidence: 0.8 }),
      undefined
    );
    expect(verdict.accept).toBe(false);
    expect(verdict.reason).toBe('weak-fact');
  });

  it('keeps a fact that clears the higher bar', () => {
    expect(
      assessCandidate(
        candidate({ kind: 'fact', confidence: NOISY_KIND_CONFIDENCE }),
        undefined
      ).accept
    ).toBe(true);
  });

  it('keeps a low-confidence decision (base gate only, not noisy)', () => {
    expect(
      assessCandidate(
        candidate({ kind: 'decision', confidence: 0.72 }),
        undefined
      ).accept
    ).toBe(true);
  });

  it('exempts bootstrap sources from the kind bar', () => {
    expect(
      assessCandidate(candidate({ kind: 'fact', confidence: 0.72 }), 'document')
        .accept
    ).toBe(true);
    expect(
      assessCandidate(
        candidate({ kind: 'episode', confidence: 0.72 }),
        'history'
      ).accept
    ).toBe(true);
  });
});
