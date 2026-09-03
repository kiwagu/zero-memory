import { describe, expect, it, vi } from 'vitest';

import type { HygieneJudge } from './hygiene-judge.js';
import {
  DEFAULT_PORTABILITY_CONFIG,
  PORTABILITY_SUBJECT_KINDS,
  clearsPortabilityGate,
  portabilityVerdictSchema,
} from './portability.js';
import { PortabilityDetector } from './portability-detector.js';

describe('clearsPortabilityGate', () => {
  const gate = DEFAULT_PORTABILITY_CONFIG.proposeConfidence;

  it('proposes a confident portable verdict', () => {
    expect(
      clearsPortabilityGate(
        { portable: true, confidence: 0.9, rationale: '' },
        gate
      )
    ).toBe(true);
  });

  it('dismisses a non-portable verdict regardless of confidence', () => {
    expect(
      clearsPortabilityGate(
        { portable: false, confidence: 0.99, rationale: '' },
        gate
      )
    ).toBe(false);
  });

  it('dismisses a low-confidence verdict (doubt dismisses)', () => {
    expect(
      clearsPortabilityGate(
        { portable: true, confidence: gate - 0.01, rationale: '' },
        gate
      )
    ).toBe(false);
  });
});

describe('PORTABILITY_SUBJECT_KINDS', () => {
  it('audits world-facing kinds and leaves owner-oracle kinds alone', () => {
    // gotcha is in because a pitfall about a public tool is exactly what
    // gets rediscovered project after project; convention and preference
    // are out because their oracle is the owner, not the outside world.
    expect([...PORTABILITY_SUBJECT_KINDS]).toEqual([
      'fact',
      'reference',
      'gotcha',
    ]);
  });
});

describe('portabilityVerdictSchema', () => {
  it('parses a minimal negative verdict (models omit no-signal fields)', () => {
    const parsed = portabilityVerdictSchema.parse({ portable: false });
    expect(parsed.confidence).toBe(0);
    expect(parsed.rationale).toBe('');
  });

  it('rejects out-of-range confidence', () => {
    expect(
      portabilityVerdictSchema.safeParse({ portable: true, confidence: 1.2 })
        .success
    ).toBe(false);
  });
});

const OWNER = 'usr_000000000000000a.0000000000';
const MEMORY = 'mem_0000000000000001.0000000000';
const CANDIDATE = 'ptc_0000000000000001.0000000000';

type Row = Record<string, unknown>;

/**
 * Minimal chainable fake of the service-role client covering exactly the
 * calls the detector makes: the rollup rpc, the claim insert, the verdict
 * update (and claim-release delete), plus usage_events / audit_log inserts.
 */
function fakeClient(rollupRows: Row[], opts: { claimConflict?: boolean } = {}) {
  const updates: Row[] = [];
  const inserts: Array<{ table: string; row: Row }> = [];
  const deletes: string[] = [];
  const client = {
    rpc: () => Promise.resolve({ data: rollupRows, error: null }),
    from(table: string) {
      if (table === 'portability_candidates') {
        return {
          insert: (row: Row) => {
            inserts.push({ table, row });
            return {
              select: () => ({
                single: () =>
                  Promise.resolve(
                    opts.claimConflict
                      ? { data: null, error: { code: '23505', message: 'dup' } }
                      : { data: { id: CANDIDATE }, error: null }
                  ),
              }),
            };
          },
          update: (row: Row) => {
            updates.push(row);
            return { eq: () => Promise.resolve({ error: null }) };
          },
          delete: () => ({
            eq: (_col: string, id: string) => {
              deletes.push(id);
              return Promise.resolve({ error: null });
            },
          }),
        };
      }
      return {
        insert: (row: Row) => {
          inserts.push({ table, row });
          return Promise.resolve({ error: null });
        },
      };
    },
  };
  return { client, updates, inserts, deletes };
}

const rollupRow = (): Row => ({
  memory_id: MEMORY,
  owner_id: OWNER,
  kind: 'fact',
  content: 'Bun loads .env only from the cwd.',
  scope: `proj.usr_000000000000000a_0000000000.zero_memory`,
});

const judgeReturning = (portable: boolean, confidence: number): HygieneJudge =>
  ({
    judgePortability: vi.fn().mockResolvedValue({
      verdict: { portable, confidence, rationale: 'r' },
      model: 'judge-model',
      inputTokens: 10,
      outputTokens: 5,
      ranOnCallerKey: false,
    }),
  }) as unknown as HygieneJudge;

describe('PortabilityDetector', () => {
  it('files a proposal (pending + audit) for a confident portable verdict', async () => {
    const { client, updates, inserts } = fakeClient([rollupRow()]);
    const detector = new PortabilityDetector(
      client as never,
      judgeReturning(true, 0.9)
    );

    const result = await detector.detect(OWNER);

    expect(result).toEqual({ candidates: 1, proposed: 1, autoDismissed: 0 });
    // The claim carries the from→to scopes; the verdict update stays pending.
    const claim = inserts.find(
      (insert) => insert.table === 'portability_candidates'
    );
    expect(claim?.row).toMatchObject({
      owner_id: OWNER,
      memory_id: MEMORY,
      to_scope: 'user.usr_000000000000000a_0000000000.core',
    });
    expect(updates[0]).toMatchObject({ judge_confidence: 0.9 });
    expect(updates[0]).not.toHaveProperty('status');
    // Proposal audit row with the dataset fields.
    const audit = inserts.find((insert) => insert.table === 'audit_log');
    expect(audit?.row).toMatchObject({ command: 'portability.propose' });
    expect((audit?.row as { payload: Row }).payload).toMatchObject({
      memory_id: MEMORY,
      to_scope: 'user.usr_000000000000000a_0000000000.core',
    });
  });

  it('auto-dismisses an unconvinced verdict with its own audit entry', async () => {
    const { client, updates, inserts } = fakeClient([rollupRow()]);
    const detector = new PortabilityDetector(
      client as never,
      judgeReturning(false, 0.95)
    );

    const result = await detector.detect(OWNER);

    expect(result).toEqual({ candidates: 1, proposed: 0, autoDismissed: 1 });
    expect(updates[0]).toMatchObject({
      status: 'dismissed',
      resolution: 'low_confidence',
    });
    const audit = inserts.find((insert) => insert.table === 'audit_log');
    expect(audit?.row).toMatchObject({ command: 'portability.auto_dismiss' });
  });

  it('skips a memory claimed by a concurrent run (23505) without judging', async () => {
    const { client } = fakeClient([rollupRow()], { claimConflict: true });
    const judge = judgeReturning(true, 0.9);
    const detector = new PortabilityDetector(client as never, judge);

    const result = await detector.detect(OWNER);

    expect(result).toEqual({ candidates: 1, proposed: 0, autoDismissed: 0 });
    expect(judge.judgePortability).not.toHaveBeenCalled();
  });

  it('releases the claim when the judgement fails so a later run retries', async () => {
    const { client, deletes } = fakeClient([rollupRow()]);
    const judge = {
      judgePortability: vi.fn().mockRejectedValue(new Error('model down')),
    } as unknown as HygieneJudge;
    const detector = new PortabilityDetector(client as never, judge);

    const result = await detector.detect(OWNER);

    expect(result).toEqual({ candidates: 1, proposed: 0, autoDismissed: 0 });
    expect(deletes).toEqual([CANDIDATE]);
  });
});
