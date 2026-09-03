import { describe, expect, it } from 'vitest';

import { LoopClosureDetector } from './loop-closure-detector.js';

/**
 * A system-wide sweep touches many people's memories in one pass, and it is
 * started with no owner at all — the schedulers call `detect()` bare. So the
 * question "whose work is this?" cannot be answered by the filter argument;
 * it has to come from each row.
 *
 * That distinction is invisible when a scan is started per user, because the
 * filter and the owner coincide. It only shows up here, in the sweep, which
 * is why this test drives one.
 */

interface FakeRow {
  loop_id: string;
  owner_id: string;
  evidence_ids: string[];
  newest_evidence_id: string;
}

/**
 * The narrowest client that gets `detect()` through one judgement per row:
 * the rollup RPC, the memory reads, the guard table, and a swallow-everything
 * writer for the outcome.
 */
const fakeClient = (rows: FakeRow[]) => {
  const memories = new Map<
    string,
    { id: string; content: string; created_at: string }
  >();
  for (const row of rows) {
    memories.set(row.loop_id, {
      id: row.loop_id,
      content: `loop ${row.loop_id}`,
      created_at: '2026-07-18T00:00:00Z',
    });
    for (const id of row.evidence_ids) {
      memories.set(id, {
        id,
        content: `evidence ${id}`,
        created_at: '2026-07-18T01:00:00Z',
      });
    }
  }

  const table = (name: string) => {
    const rowsFor = () => {
      if (name === 'memories') return [...memories.values()];
      return [];
    };
    const builder: Record<string, unknown> = {};
    for (const method of [
      'select',
      'eq',
      'in',
      'is',
      'order',
      'limit',
      'gte',
    ]) {
      builder[method] = () => builder;
    }
    builder['insert'] = () => Promise.resolve({ data: null, error: null });
    builder['update'] = () => builder;
    builder['upsert'] = () => Promise.resolve({ data: null, error: null });
    builder['maybeSingle'] = () =>
      Promise.resolve({ data: rowsFor()[0] ?? null, error: null });
    builder['single'] = () =>
      Promise.resolve({ data: rowsFor()[0] ?? null, error: null });
    builder['then'] = (resolve: (value: unknown) => unknown) =>
      resolve({ data: rowsFor(), error: null });
    return builder;
  };

  return {
    rpc: (name: string) =>
      name === 'find_loop_closure_evidence'
        ? Promise.resolve({ data: rows, error: null })
        : Promise.resolve({ data: null, error: null }),
    from: (name: string) => table(name),
  };
};

const judgeReturning = () => {
  const seen: (string | undefined)[] = [];
  const judge = {
    judge: (
      _loop: unknown,
      _evidence: unknown,
      ownerId?: string
    ): Promise<never> => {
      seen.push(ownerId);
      // Rejecting closure keeps the test to the one thing it is about: who the
      // call was made for. A closing verdict would drag in the write path.
      return Promise.resolve({
        verdict: { closed: false, confidence: 0.1, rationale: 'not yet' },
        model: 'a-model',
        inputTokens: 1,
        outputTokens: 1,
        ranOnCallerKey: false,
      }) as Promise<never>;
    },
  };
  return { seen, judge };
};

describe('a system-wide sweep attributes each judgement to its own owner', () => {
  it('names the row owner, not the (absent) filter', async () => {
    const { seen, judge } = judgeReturning();
    const detector = new LoopClosureDetector(
      fakeClient([
        {
          loop_id: 'mem_loop_a',
          owner_id: 'usr_alice',
          evidence_ids: ['mem_ev_a'],
          newest_evidence_id: 'mem_ev_a',
        },
        {
          loop_id: 'mem_loop_b',
          owner_id: 'usr_bob',
          evidence_ids: ['mem_ev_b'],
          newest_evidence_id: 'mem_ev_b',
        },
      ]) as never,
      judge as never
    );

    // No owner: this is the scheduled sweep, exactly as the schedulers run it.
    await detector.detect();

    // Two owners in one pass, each judged as themselves. Before per-row
    // attribution both of these were `undefined`, and the work silently fell
    // to the platform key and the instance allowance.
    expect(seen).toEqual(['usr_alice', 'usr_bob']);
  });
});
