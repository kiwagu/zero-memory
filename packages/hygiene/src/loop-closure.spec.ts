import { describe, expect, it } from 'vitest';

import {
  DEFAULT_LOOP_CLOSURE_CONFIG,
  loopClosureVerdictSchema,
} from './loop-closure.js';
import { clearsLoopClosureGate } from './loop-closure-detector.js';

describe('clearsLoopClosureGate', () => {
  const gate = DEFAULT_LOOP_CLOSURE_CONFIG.closeConfidence;
  const shown = ['mem_evidence_a', 'mem_evidence_b'];

  it('closes on a confident verdict naming shown evidence', () => {
    expect(
      clearsLoopClosureGate(
        {
          closed: true,
          evidence_id: 'mem_evidence_a',
          confidence: 0.95,
          rationale: 'The merge fact asserts the work is done.',
        },
        gate,
        shown
      )
    ).toBe(true);
  });

  it('leaves open on a negative verdict regardless of confidence', () => {
    expect(
      clearsLoopClosureGate(
        { closed: false, evidence_id: '', confidence: 0.99, rationale: '' },
        gate,
        shown
      )
    ).toBe(false);
  });

  it('leaves open below the confidence gate (doubt keeps the loop)', () => {
    expect(
      clearsLoopClosureGate(
        {
          closed: true,
          evidence_id: 'mem_evidence_a',
          confidence: gate - 0.01,
          rationale: '',
        },
        gate,
        shown
      )
    ).toBe(false);
  });

  it('leaves open when the named evidence was not shown to the judge', () => {
    expect(
      clearsLoopClosureGate(
        {
          closed: true,
          evidence_id: 'mem_hallucinated',
          confidence: 0.99,
          rationale: '',
        },
        gate,
        shown
      )
    ).toBe(false);
  });
});

describe('loopClosureVerdictSchema', () => {
  it('parses a minimal negative verdict via defaults', () => {
    const verdict = loopClosureVerdictSchema.parse({ closed: false });
    expect(verdict.evidence_id).toBe('');
    expect(verdict.confidence).toBe(0);
    expect(verdict.rationale).toBe('');
  });

  it('rejects an out-of-range confidence', () => {
    expect(() =>
      loopClosureVerdictSchema.parse({ closed: true, confidence: 1.5 })
    ).toThrow();
  });
});
