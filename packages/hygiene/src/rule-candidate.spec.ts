import type { Client } from '@workspace/persistence';
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_INCUBATOR_CONFIG,
  MAX_SCOPE_SUGGESTIONS,
  RULE_CANDIDATE_KINDS,
  mergeScopeSuggestions,
  ruleDistillationSchema,
  targetLayerForScope,
} from './rule-candidate.js';
import {
  clearsDistillGate,
  RuleCandidateDetector,
} from './rule-candidate-detector.js';
import type {
  RuleDistiller,
  RuleDistillerJudgement,
} from './rule-distiller.js';

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

describe('RULE_CANDIDATE_KINDS', () => {
  it('proposes conventions, preferences, and gotchas only (v1)', () => {
    expect([...RULE_CANDIDATE_KINDS]).toEqual([
      'convention',
      'preference',
      'gotcha',
    ]);
  });
});

describe('promoteOnDemand metering', () => {
  const OWNER = 'usr_owner_1';
  const memory = {
    id: 'mem_probe',
    kind: 'preference',
    scope: `user.${OWNER}`,
    content: 'prefer bun over npm',
    owner_id: OWNER,
    invalidated_at: null,
  };

  const judgement: RuleDistillerJudgement = {
    verdict: {
      rule: true,
      rule_text: 'Always prefer bun over npm.',
      confidence: 0.9,
      rationale: 'standing preference',
      scope_suggestions: [],
    },
    model: 'test-model',
    inputTokens: 120,
    outputTokens: 30,
    ranOnCallerKey: false,
  };

  /**
   * Minimal chainable Supabase stub: records every insert/upsert so the test
   * can assert whether the distiller call was metered into usage_events.
   */
  const makeClient = (
    writes: Array<{ table: string; row: unknown }>
  ): Client => {
    const builder = (table: string): Record<string, unknown> => ({
      select: () => builder(table),
      eq: () => builder(table),
      maybeSingle: async () => ({ data: memory, error: null }),
      insert: async (row: unknown) => {
        writes.push({ table, row });
        return { error: null };
      },
      upsert: async (row: unknown) => {
        writes.push({ table, row });
        return { error: null };
      },
    });
    return { from: (table: string) => builder(table) } as unknown as Client;
  };

  const distiller = {
    distill: async () => judgement,
  } as unknown as RuleDistiller;

  it('meters the distiller call into usage_events when it distills', async () => {
    const writes: Array<{ table: string; row: unknown }> = [];
    const detector = new RuleCandidateDetector(makeClient(writes), distiller);

    await detector.promoteOnDemand({ memoryId: memory.id, ownerId: OWNER });

    const metered = writes.find((w) => w.table === 'usage_events');
    expect(metered, 'usage_events insert must exist').toBeDefined();
    const row = metered?.row as {
      user_id: string;
      quantity: number;
      metadata: { purpose: string };
    };
    expect(row.user_id).toBe(OWNER);
    expect(row.quantity).toBe(judgement.inputTokens + judgement.outputTokens);
    expect(row.metadata.purpose).toBe('rule_distiller');
  });

  it('does NOT call the distiller or meter when rule_text is supplied', async () => {
    const writes: Array<{ table: string; row: unknown }> = [];
    let distilled = false;
    const spyDistiller = {
      distill: async () => {
        distilled = true;
        return judgement;
      },
    } as unknown as RuleDistiller;
    const detector = new RuleCandidateDetector(
      makeClient(writes),
      spyDistiller
    );

    await detector.promoteOnDemand({
      memoryId: memory.id,
      ownerId: OWNER,
      ruleText: 'Always prefer bun over npm.',
    });

    expect(distilled).toBe(false);
    expect(writes.some((w) => w.table === 'usage_events')).toBe(false);
  });
});

describe('promoteOnDemand dismissed guard', () => {
  const OWNER = 'usr_owner_2';
  const memory = {
    id: 'mem_dismissed',
    kind: 'preference',
    scope: `user.${OWNER}`,
    content: 'a memory once dismissed as a rule',
    owner_id: OWNER,
    invalidated_at: null,
  };

  /**
   * Table-aware stub: memories returns the owned memory; rule_candidates
   * returns an existing DISMISSED candidacy for the status probe.
   */
  const makeClient = (writes: Array<{ table: string }>): Client => {
    const builder = (table: string): Record<string, unknown> => ({
      select: () => builder(table),
      eq: () => builder(table),
      maybeSingle: async () => ({
        data: table === 'memories' ? memory : { status: 'dismissed' },
        error: null,
      }),
      upsert: async () => {
        writes.push({ table });
        return { error: null };
      },
      insert: async () => {
        writes.push({ table });
        return { error: null };
      },
    });
    return { from: (table: string) => builder(table) } as unknown as Client;
  };

  it('refuses a dismissed candidacy without force (no upsert)', async () => {
    const writes: Array<{ table: string }> = [];
    const detector = new RuleCandidateDetector(makeClient(writes));

    await expect(
      detector.promoteOnDemand({
        memoryId: memory.id,
        ownerId: OWNER,
        ruleText: 'x',
      })
    ).rejects.toThrow(/dismissed/);
    expect(writes.some((w) => w.table === 'rule_candidates')).toBe(false);
  });

  it('promotes a dismissed candidacy when force is set', async () => {
    const writes: Array<{ table: string }> = [];
    const detector = new RuleCandidateDetector(makeClient(writes));

    const result = await detector.promoteOnDemand({
      memoryId: memory.id,
      ownerId: OWNER,
      ruleText: 'x',
      force: true,
    });
    expect(result.status).toBe('promoted');
    expect(writes.some((w) => w.table === 'rule_candidates')).toBe(true);
  });
});
