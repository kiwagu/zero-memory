import { describe, expect, it, vi } from 'vitest';

import { RuleCandidateDetector } from './rule-candidate-detector.js';
import { RuleDistiller } from './rule-distiller.js';

const OWNER = 'usr_000000000000000a.0000000000';
const MEMORY = 'mem_0000000000000001.0000000000';

/**
 * Minimal chainable fake of the service-role Supabase client covering exactly
 * the calls promoteOnDemand makes: a memories select→eq→maybeSingle, a
 * rule_candidates status probe (select→eq→maybeSingle, no prior candidacy by
 * default), a rule_candidates upsert, and an audit_log insert. `upserts`
 * captures the row; `existingStatus` seeds the guard probe.
 */
function fakeClient(
  memory: Record<string, unknown> | null,
  existingStatus: string | null = null
) {
  const upserts: Array<{ row: Record<string, unknown>; opts: unknown }> = [];
  const client = {
    from(table: string) {
      if (table === 'memories') {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: () => Promise.resolve({ data: memory, error: null }),
            }),
          }),
        };
      }
      if (table === 'rule_candidates') {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: () =>
                Promise.resolve({
                  data: existingStatus ? { status: existingStatus } : null,
                  error: null,
                }),
            }),
          }),
          upsert: (row: Record<string, unknown>, opts: unknown) => {
            upserts.push({ row, opts });
            return Promise.resolve({ error: null });
          },
        };
      }
      return { insert: () => Promise.resolve({ error: null }) };
    },
  };
  return { client, upserts };
}

const distillerReturning = (ruleText: string): RuleDistiller =>
  ({
    distill: vi.fn().mockResolvedValue({
      verdict: {
        rule: true,
        rule_text: ruleText,
        confidence: 0.9,
        rationale: 'because',
        scope_suggestions: [],
      },
      model: 'a-model',
    }),
  }) as unknown as RuleDistiller;

const make = (
  memory: Record<string, unknown> | null,
  distillText = 'distilled rule'
) => {
  const { client, upserts } = fakeClient(memory);
  const distiller = distillerReturning(distillText);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const detector = new RuleCandidateDetector(client as any, distiller);
  return { detector, upserts, distiller };
};

const personalMemory = {
  id: MEMORY,
  kind: 'preference',
  scope: 'user.usr_000000000000000a_0000000000',
  content: 'the raw memory content',
  owner_id: OWNER,
  invalidated_at: null,
};

describe('RuleCandidateDetector.promoteOnDemand', () => {
  it('promotes a personal-scope memory to a General (user-layer) rule, distilling text', async () => {
    const { detector, upserts, distiller } = make(personalMemory);

    const out = await detector.promoteOnDemand({
      memoryId: MEMORY,
      ownerId: OWNER,
    });

    expect(out).toMatchObject({
      memory_id: MEMORY,
      rule_text: 'distilled rule',
      target_layer: 'user',
      applies_scope: null,
      status: 'promoted',
    });
    expect(distiller.distill).toHaveBeenCalledOnce();
    const { row, opts } = upserts[0]!;
    expect(row).toMatchObject({
      memory_id: MEMORY,
      status: 'promoted',
      resolution: 'promoted',
      resolved_by: OWNER,
      target_layer: 'user',
      applies_scope: null,
      rule_text: 'distilled rule',
    });
    expect(opts).toEqual({ onConflict: 'memory_id' });
  });

  it('addresses a PROJECT rule when applies_scope is given', async () => {
    const { detector, upserts } = make(personalMemory);

    const out = await detector.promoteOnDemand({
      memoryId: MEMORY,
      ownerId: OWNER,
      appliesScope: 'proj.usr_000000000000000a_0000000000.zero_memory',
    });

    expect(out.target_layer).toBe('project');
    expect(out.applies_scope).toBe(
      'proj.usr_000000000000000a_0000000000.zero_memory'
    );
    expect(upserts[0]!.row.target_layer).toBe('project');
  });

  it('uses an explicit rule_text without calling the distiller', async () => {
    const { detector, upserts, distiller } = make(personalMemory);

    const out = await detector.promoteOnDemand({
      memoryId: MEMORY,
      ownerId: OWNER,
      ruleText: '  always run the e2e suite before review  ',
    });

    expect(distiller.distill).not.toHaveBeenCalled();
    expect(out.rule_text).toBe('always run the e2e suite before review');
    expect(upserts[0]!.row.rule_text).toBe(
      'always run the e2e suite before review'
    );
  });

  it('refuses a memory the caller does not own', async () => {
    const { detector } = make({ ...personalMemory, owner_id: 'usr_other' });
    await expect(
      detector.promoteOnDemand({ memoryId: MEMORY, ownerId: OWNER })
    ).rejects.toThrow(/not found or not owned/);
  });

  it('refuses an invalidated memory', async () => {
    const { detector } = make({
      ...personalMemory,
      invalidated_at: new Date().toISOString(),
    });
    await expect(
      detector.promoteOnDemand({ memoryId: MEMORY, ownerId: OWNER })
    ).rejects.toThrow(/invalidated/);
  });
});
