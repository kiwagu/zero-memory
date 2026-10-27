import { describe, expect, it, vi } from 'vitest';

import { RuleCandidateDetector } from './rule-candidate-detector.js';
import type { RuleDistiller } from './rule-distiller.js';

const OWNER = 'usr_000000000000000a.0000000000';
const MEMORY = 'mem_0000000000000001.0000000000';
const CANDIDATE = 'rlc_0000000000000001.0000000000';

type Row = Record<string, unknown>;

/**
 * Minimal chainable fake of the service-role client covering exactly the
 * calls one detection run makes for a single candidate with no neighbours
 * and an empty scope inventory: the un-snooze sweep, the rollup rpc, the
 * candidacy upsert, the neighbour and inventory reads, the draft update, and
 * the usage_events / audit_log inserts. `updates` captures every
 * rule_candidates update.
 */
function fakeClient(rollupRows: Row[]) {
  const updates: Row[] = [];
  const client = {
    rpc: () => Promise.resolve({ data: rollupRows, error: null }),
    from(table: string) {
      if (table === 'rule_candidates') {
        return {
          update: (row: Row) => {
            updates.push(row);
            return {
              // The draft save awaits `.eq()`; the un-snooze sweep chains on.
              eq: () =>
                Object.assign(Promise.resolve({ error: null }), {
                  lte: () => ({
                    select: () => Promise.resolve({ data: [], error: null }),
                  }),
                }),
            };
          },
          upsert: () => ({
            select: () =>
              Promise.resolve({ data: [{ id: CANDIDATE }], error: null }),
          }),
        };
      }
      if (table === 'memory_links') {
        return {
          select: () => ({
            or: () => ({
              limit: () => Promise.resolve({ data: [], error: null }),
            }),
          }),
        };
      }
      if (table === 'memories') {
        return {
          select: () => ({
            eq: () => ({
              is: () => ({
                order: () => ({
                  range: () => Promise.resolve({ data: [], error: null }),
                }),
              }),
            }),
          }),
        };
      }
      return { insert: () => Promise.resolve({ error: null }) };
    },
  };
  return { client, updates };
}

const distillerReturning = (appliesWhen: string | null): RuleDistiller =>
  ({
    distill: vi.fn().mockResolvedValue({
      verdict: {
        rule: true,
        rule_text: 'Always run the commit guard before committing.',
        applies_when: appliesWhen,
        confidence: 0.9,
        rationale: 'standing convention',
        scope_suggestions: [],
      },
      model: 'a-model',
      inputTokens: 100,
      outputTokens: 20,
      ranOnCallerKey: false,
    }),
  }) as unknown as RuleDistiller;

describe('RuleCandidateDetector.detect', () => {
  it("keeps the distiller's applies_when on the queued draft", async () => {
    const { client, updates } = fakeClient([
      {
        memory_id: MEMORY,
        owner_id: OWNER,
        kind: 'convention',
        scope: 'user.usr_000000000000000a_0000000000',
        content: 'run the commit guard before every commit',
        useful_sessions: 3,
        first_used_at: null,
        last_used_at: null,
        session_keys: null,
      },
    ]);
    const detector = new RuleCandidateDetector(
      client as never,
      distillerReturning('any task that commits to git')
    );

    const result = await detector.detect(OWNER);

    expect(result.distilled).toBe(1);
    expect(updates).toContainEqual(
      expect.objectContaining({
        rule_text: 'Always run the commit guard before committing.',
        applies_when: 'any task that commits to git',
      })
    );
  });
});
