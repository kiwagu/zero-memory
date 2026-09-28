import { describe, expect, it, vi } from 'vitest';

import type { HygieneJudge } from './hygiene-judge.js';
import { HygieneScanner } from './hygiene-scanner.js';

const OWNER = 'usr_000000000000000a.0000000000';
const SCOPE = 'proj.usr_000000000000000a_0000000000.zero_memory';

const memory = (id: string, createdAt: string) => ({
  id,
  // A fact is not a protected kind, so a confident duplicate auto-resolves.
  kind: 'fact',
  content: `content of ${id}`,
  scope: SCOPE,
  source: null,
  created_at: createdAt,
  author_kind: 'agent',
  agent_name: 'claude-code',
  owner_id: OWNER,
});

const SUBJECT = memory(
  'mem_000000000000000b.0000000000',
  '2026-09-28T10:00:00Z'
);
const OLDER = memory('mem_000000000000000c.0000000000', '2026-09-01T10:00:00Z');

/**
 * A chainable stand-in for the service-role client: every builder call
 * returns the builder, awaiting it answers what `answer` says for the table,
 * and every `update` payload is recorded per table.
 */
function fakeClient() {
  const updates: Array<{ table: string; payload: Record<string, unknown> }> =
    [];
  const answer = (table: string, single: boolean): unknown => {
    if (table === 'memories') {
      return single ? SUBJECT : [SUBJECT, OLDER];
    }
    return [];
  };
  const builder = (table: string) => {
    let single = false;
    const chain: Record<string, unknown> = {};
    const settle = () =>
      Promise.resolve({ data: answer(table, single), error: null });
    for (const method of [
      'select',
      'eq',
      'is',
      'in',
      'or',
      'limit',
      'order',
      'insert',
      'upsert',
    ]) {
      chain[method] = () => chain;
    }
    chain.update = (payload: Record<string, unknown>) => {
      updates.push({ table, payload });
      return chain;
    };
    chain.maybeSingle = () => {
      single = true;
      return settle();
    };
    chain.then = (
      resolve: (value: unknown) => unknown,
      reject: (reason: unknown) => unknown
    ) => settle().then(resolve, reject);
    return chain;
  };
  const client = {
    from: (table: string) => builder(table),
    rpc: () =>
      Promise.resolve({ data: [{ ...OLDER, similarity: 0.97 }], error: null }),
  };
  return { client, updates };
}

const judgeSaying = (relation: string, confidence: number): HygieneJudge =>
  ({
    judge: vi.fn().mockResolvedValue({
      verdict: { relation, confidence, rationale: 'the same fact twice' },
      model: 'a-model',
      inputTokens: 0,
      outputTokens: 0,
    }),
  }) as unknown as HygieneJudge;

describe('HygieneScanner auto-resolution', () => {
  it('records the winner of an auto-duplicate as the successor of the loser', async () => {
    const { client, updates } = fakeClient();
    const scanner = new HygieneScanner(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      client as any,
      judgeSaying('duplicate', 0.99)
    );

    const result = await scanner.scanOne(SUBJECT.id);

    expect(result.autoResolved).toBe(1);
    // The retired twin names the memory that replaced it, so everything
    // anchored to it — a promoted rule above all — can follow the winner.
    const retired = updates.filter((update) => update.table === 'memories');
    expect(retired).toHaveLength(1);
    expect(retired[0]!.payload).toMatchObject({
      superseded_by: SUBJECT.id,
      invalidated_by_agent: 'hygiene-scanner',
      invalidated_by_model: 'a-model',
    });
    expect(retired[0]!.payload.invalidated_at).toEqual(expect.any(String));
  });
});
