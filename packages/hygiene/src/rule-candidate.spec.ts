import { describe, expect, it } from 'vitest';

import {
  DEFAULT_INCUBATOR_CONFIG,
  MAX_SCOPE_SUGGESTIONS,
  mergeScopeSuggestions,
  ruleDistillationSchema,
  targetLayerForScope,
} from './rule-candidate.js';
import { clearsDistillGate } from './rule-candidate-detector.js';

describe('targetLayerForScope', () => {
  it('routes personal scopes to the user layer', () => {
    expect(targetLayerForScope('user.usr_abc_123')).toBe('user');
    expect(targetLayerForScope('user.usr_abc_123.core')).toBe('user');
    expect(targetLayerForScope('user')).toBe('user');
  });

  it('routes everything else to the project layer', () => {
    expect(targetLayerForScope('proj.zero_memory')).toBe('project');
    expect(targetLayerForScope('proj.acme.api')).toBe('project');
    // A scope merely mentioning "user" deeper in the path is not personal.
    expect(targetLayerForScope('proj.user_service')).toBe('project');
  });
});

describe('clearsDistillGate', () => {
  const gate = DEFAULT_INCUBATOR_CONFIG.distillConfidence;

  it('queues a confident rule verdict', () => {
    expect(
      clearsDistillGate(
        { rule: true, rule_text: 'Always X.', confidence: 0.9, rationale: '' },
        gate
      )
    ).toBe(true);
  });

  it('dismisses a not-a-rule verdict regardless of confidence', () => {
    expect(
      clearsDistillGate(
        { rule: false, rule_text: '', confidence: 0.99, rationale: '' },
        gate
      )
    ).toBe(false);
  });

  it('dismisses a low-confidence rule verdict (doubt dismisses)', () => {
    expect(
      clearsDistillGate(
        {
          rule: true,
          rule_text: 'Maybe X.',
          confidence: gate - 0.01,
          rationale: '',
        },
        gate
      )
    ).toBe(false);
    // The gate itself is inclusive: "at or above" queues.
    expect(
      clearsDistillGate(
        { rule: true, rule_text: 'X.', confidence: gate, rationale: '' },
        gate
      )
    ).toBe(true);
  });
});

describe('ruleDistillationSchema', () => {
  it('validates a distillation and rejects out-of-range confidence', () => {
    expect(
      ruleDistillationSchema.parse({
        rule: true,
        rule_text:
          'Always pin `set search_path` in security definer functions.',
        confidence: 0.8,
        rationale: 'standing convention',
      }).rule
    ).toBe(true);
    expect(() =>
      ruleDistillationSchema.parse({
        rule: true,
        rule_text: 'x',
        confidence: 1.3,
        rationale: 'x',
      })
    ).toThrow();
  });
});

describe('mergeScopeSuggestions', () => {
  const inventory = [
    'proj.alpha',
    'proj.beta',
    'user.usr_abc_123',
  ] as const satisfies readonly string[];

  it('always puts the deterministic origin entry first at score 1', () => {
    const merged = mergeScopeSuggestions('proj.alpha', [], inventory);
    expect(merged).toEqual([
      { scope: 'proj.alpha', score: 1, source: 'origin' },
    ]);
  });

  it('ranks validated LLM guesses after the origin, labelling personal as global', () => {
    const merged = mergeScopeSuggestions(
      'proj.alpha',
      [
        { scope: 'proj.beta', confidence: 0.4 },
        { scope: 'user.usr_abc_123', confidence: 0.9 },
      ],
      inventory
    );
    expect(merged.map((entry) => entry.scope)).toEqual([
      'proj.alpha',
      'user.usr_abc_123',
      'proj.beta',
    ]);
    expect(merged[1]?.source).toBe('global');
    expect(merged[2]?.source).toBe('llm');
  });

  it('drops hallucinated, duplicate-of-origin, and out-of-range entries', () => {
    const merged = mergeScopeSuggestions(
      'proj.alpha',
      [
        { scope: 'proj.hallucinated', confidence: 0.9 }, // not in inventory
        { scope: 'proj.alpha', confidence: 0.9 }, // redundant with origin
        { scope: 'proj.beta', confidence: 2 }, // clamped to 1
        { scope: 'proj.beta', confidence: 0.3 }, // dedup keeps the max
        { scope: '  ', confidence: 0.9 }, // empty
      ],
      inventory
    );
    expect(merged).toEqual([
      { scope: 'proj.alpha', score: 1, source: 'origin' },
      { scope: 'proj.beta', score: 1, source: 'llm' },
    ]);
  });

  it('caps the speculative tail', () => {
    const wide = Array.from({ length: 10 }, (_, index) => `proj.p${index}`);
    const merged = mergeScopeSuggestions(
      'proj.alpha',
      wide.map((scope) => ({ scope, confidence: 0.5 })),
      ['proj.alpha', ...wide]
    );
    expect(merged).toHaveLength(1 + MAX_SCOPE_SUGGESTIONS);
  });
});
