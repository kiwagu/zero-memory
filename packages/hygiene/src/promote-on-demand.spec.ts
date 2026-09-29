import { describe, expect, it, vi } from 'vitest';

import { RuleCandidateDetector } from './rule-candidate-detector.js';
import { RuleDistiller } from './rule-distiller.js';

const OWNER = 'usr_000000000000000a.0000000000';
const MEMORY = 'mem_0000000000000001.0000000000';

/**
 * Minimal chainable fake of the service-role Supabase client covering exactly
 * the calls promoteOnDemand makes: a memories select→eq→maybeSingle, a
 * rule_candidates status probe (select→eq→maybeSingle, no prior candidacy by
 * default), a rule_candidates upsert, and the usage_events / audit_log
 * inserts. `upserts` captures the candidacy row, `inserts` every other write;
 * `existing` seeds the status probe.
 */
function fakeClient(
  memory: Record<string, unknown> | null,
  existing: Record<string, unknown> | null = null
) {
  const upserts: Array<{ row: Record<string, unknown>; opts: unknown }> = [];
  const inserts: Array<{ table: string; row: Record<string, unknown> }> = [];
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
                Promise.resolve({ data: existing, error: null }),
            }),
          }),
          upsert: (row: Record<string, unknown>, opts: unknown) => {
            upserts.push({ row, opts });
            return Promise.resolve({ error: null });
          },
        };
      }
      return {
        insert: (row: Record<string, unknown>) => {
          inserts.push({ table, row });
          return Promise.resolve({ error: null });
        },
      };
    },
  };
  return { client, upserts, inserts };
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
      inputTokens: 120,
      outputTokens: 30,
      ranOnCallerKey: false,
    }),
  }) as unknown as RuleDistiller;

const make = (
  memory: Record<string, unknown> | null,
  distillText = 'distilled rule',
  existing: Record<string, unknown> | null = null
) => {
  const { client, upserts, inserts } = fakeClient(memory, existing);
  const distiller = distillerReturning(distillText);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const detector = new RuleCandidateDetector(client as any, distiller);
  return { detector, upserts, inserts, distiller };
};

const metered = (inserts: Array<{ table: string }>) =>
  inserts.filter((insert) => insert.table === 'usage_events');

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

  it("meters the distiller's tokens on the owner's ledger", async () => {
    const { detector, inserts } = make(personalMemory);

    await detector.promoteOnDemand({ memoryId: MEMORY, ownerId: OWNER });

    // The on-demand distill spends tokens on the owner's behalf, so it lands
    // on their allowance under its own purpose, like the incubator run.
    expect(metered(inserts)).toHaveLength(1);
    expect(metered(inserts)[0]).toMatchObject({
      row: {
        user_id: OWNER,
        quantity: 150,
        metadata: { purpose: 'rule_distiller' },
      },
    });
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

  it('uses an explicit rule_text without calling or metering the distiller', async () => {
    const { detector, upserts, inserts, distiller } = make(personalMemory);

    const out = await detector.promoteOnDemand({
      memoryId: MEMORY,
      ownerId: OWNER,
      ruleText: '  always run the e2e suite before review  ',
    });

    expect(distiller.distill).not.toHaveBeenCalled();
    expect(metered(inserts)).toEqual([]);
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

  it('refuses to revive a dismissed candidacy without force', async () => {
    const { detector, upserts } = make(personalMemory, 'unused', {
      status: 'dismissed',
    });

    // The owner turned this rule down on purpose; promoting it again takes
    // an explicit override.
    await expect(
      detector.promoteOnDemand({
        memoryId: MEMORY,
        ownerId: OWNER,
        ruleText: 'x',
      })
    ).rejects.toThrow(/dismissed/);
    expect(upserts).toEqual([]);
  });

  it('promotes a dismissed candidacy when force is set', async () => {
    const { detector, upserts } = make(personalMemory, 'unused', {
      status: 'dismissed',
    });

    const out = await detector.promoteOnDemand({
      memoryId: MEMORY,
      ownerId: OWNER,
      ruleText: 'x',
      force: true,
    });

    expect(out.status).toBe('promoted');
    expect(upserts).toHaveLength(1);
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

  it('refuses a superseded memory by naming the successor its rule follows', async () => {
    const successor = 'mem_0000000000000002.0000000000';
    const { detector } = make({
      ...personalMemory,
      invalidated_at: new Date().toISOString(),
      superseded_by: successor,
    });
    await expect(
      detector.promoteOnDemand({ memoryId: MEMORY, ownerId: OWNER })
    ).rejects.toThrow(
      new RegExp(`superseded by ${successor}.*promote_rule on ${successor}`)
    );
  });

  it('keeps the address of a live or revoked rule when re-promoted without one', async () => {
    for (const status of ['promoted', 'revoked']) {
      // A rule carried from a project memory to a personal one keeps the
      // project it was delivered to; setting its text again must not undo it.
      const { detector, upserts } = make(personalMemory, 'unused', {
        status,
        target_layer: 'project',
        applies_scope: 'proj.usr_000000000000000a_0000000000.zero_memory',
      });

      const out = await detector.promoteOnDemand({
        memoryId: MEMORY,
        ownerId: OWNER,
        ruleText: 'the corrected text',
        force: true,
      });

      expect(out).toMatchObject({
        target_layer: 'project',
        applies_scope: 'proj.usr_000000000000000a_0000000000.zero_memory',
      });
      expect(upserts[0]!.row).toMatchObject({
        target_layer: 'project',
        applies_scope: 'proj.usr_000000000000000a_0000000000.zero_memory',
        rule_text: 'the corrected text',
      });
    }
  });

  it('a named address wins, and a mere proposal is addressed afresh', async () => {
    const named = make(personalMemory, 'unused', {
      status: 'promoted',
      target_layer: 'project',
      applies_scope: 'proj.usr_000000000000000a_0000000000.old',
    });
    const renamed = await named.detector.promoteOnDemand({
      memoryId: MEMORY,
      ownerId: OWNER,
      ruleText: 'text',
      appliesScope: 'proj.usr_000000000000000a_0000000000.new',
    });
    expect(renamed.applies_scope).toBe(
      'proj.usr_000000000000000a_0000000000.new'
    );

    const proposal = make(personalMemory, 'unused', {
      status: 'pending',
      target_layer: 'project',
      applies_scope: 'proj.usr_000000000000000a_0000000000.old',
    });
    const fresh = await proposal.detector.promoteOnDemand({
      memoryId: MEMORY,
      ownerId: OWNER,
      ruleText: 'text',
    });
    expect(fresh).toMatchObject({ target_layer: 'user', applies_scope: null });
  });

  it('makes a revoked rule live again: the revoke and the review flag are cleared', async () => {
    const { detector, upserts } = make(personalMemory);

    await detector.promoteOnDemand({
      memoryId: MEMORY,
      ownerId: OWNER,
      ruleText: 'always squash',
      force: true,
    });

    // A promoted row with a revoke is never delivered, so the upsert must
    // clear it in the same statement that sets the status.
    expect(upserts[0]!.row).toMatchObject({
      status: 'promoted',
      revoked_at: null,
      revoke_reason: null,
      text_review_since: null,
    });
  });
});
