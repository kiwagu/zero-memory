import { describe, expect, it } from 'vitest';

import {
  DEFAULT_REFLECTION_CONFIG,
  reflectionDistillationSchema,
} from './reflection.js';
import { clearsReflectionGate } from './reflection-detector.js';

describe('clearsReflectionGate', () => {
  const gate = DEFAULT_REFLECTION_CONFIG.distillConfidence;

  it('queues a confident consolidation verdict', () => {
    expect(
      clearsReflectionGate(
        {
          consolidate: true,
          content: 'The stack settled on X after three iterations.',
          kind: 'fact',
          confidence: 0.9,
          rationale: '',
        },
        gate
      )
    ).toBe(true);
  });

  it('dismisses a not-consolidatable verdict regardless of confidence', () => {
    expect(
      clearsReflectionGate(
        {
          consolidate: false,
          content: '',
          kind: 'fact',
          confidence: 0.99,
          rationale: '',
        },
        gate
      )
    ).toBe(false);
  });

  it('dismisses a low-confidence verdict (doubt dismisses)', () => {
    expect(
      clearsReflectionGate(
        {
          consolidate: true,
          content: 'Maybe.',
          kind: 'convention',
          confidence: gate - 0.01,
          rationale: '',
        },
        gate
      )
    ).toBe(false);
  });
});

describe('reflectionDistillationSchema', () => {
  it('accepts only the reflection kinds', () => {
    expect(
      reflectionDistillationSchema.safeParse({
        consolidate: true,
        content: 'Consolidated.',
        kind: 'gotcha',
        confidence: 0.8,
        rationale: 'r',
      }).success
    ).toBe(false);
    expect(
      reflectionDistillationSchema.safeParse({
        consolidate: true,
        content: 'Consolidated.',
        kind: 'convention',
        confidence: 0.8,
        rationale: 'r',
      }).success
    ).toBe(true);
  });

  it('bounds the similarity band defaults below the dedup threshold', () => {
    // The ceiling must stay below write-time same-scope dedup (0.92): at or
    // above it a pair is dedup territory, not consolidation.
    expect(DEFAULT_REFLECTION_CONFIG.maxSimilarity).toBeLessThanOrEqual(0.92);
    expect(DEFAULT_REFLECTION_CONFIG.minSimilarity).toBeLessThan(
      DEFAULT_REFLECTION_CONFIG.maxSimilarity
    );
    expect(DEFAULT_REFLECTION_CONFIG.minClusterSize).toBeGreaterThanOrEqual(3);
  });
});
