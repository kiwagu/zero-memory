import { vi } from 'vitest';

import type { Client } from '../supabase.client.js';

/** A stored `rule_candidates` row, holding the columns a spec cares about. */
export type RuleCandidateRow = { id: string } & Record<string, unknown>;

interface Answer {
  data: unknown;
  error: { message: string } | null;
}

/**
 * The PostgREST builder over `rule_candidates`, held in memory: equality,
 * `is null` and `not is null` filters narrow the rows, `order` is accepted
 * and ignored (delivery order is the readers' to decide), and `range` or
 * `maybeSingle` answer. RLS is not modelled — the rows ARE what the caller's
 * policies admit.
 */
const query = (rows: readonly RuleCandidateRow[]) => {
  let kept = [...rows];
  const builder = {
    select: () => builder,
    eq: (column: string, value: unknown) => {
      kept = kept.filter((row) => row[column] === value);
      return builder;
    },
    is: (column: string, value: null) => {
      kept = kept.filter((row) => (row[column] ?? null) === value);
      return builder;
    },
    not: (column: string, operator: 'is', value: null) => {
      if (operator !== 'is') {
        throw new Error(`fake supports only not(…, 'is', null)`);
      }
      kept = kept.filter((row) => (row[column] ?? null) !== value);
      return builder;
    },
    order: () => builder,
    range: (from: number, to: number): Promise<Answer> =>
      Promise.resolve({ data: kept.slice(from, to + 1), error: null }),
    maybeSingle: (): Promise<Answer> =>
      Promise.resolve(
        kept.length > 1
          ? { data: null, error: { message: 'more than one row' } }
          : { data: kept[0] ?? null, error: null }
      ),
  };
  return builder;
};

/**
 * A user client whose only table is `rule_candidates`, holding `rows`.
 * `from` is a spy, so a spec can tell whether a query was made at all.
 *
 * Spec support only (it imports vitest) and deliberately not exported from
 * the package.
 */
export const fakeRuleCandidateClient = (rows: readonly RuleCandidateRow[]) => {
  const from = vi.fn((table: string) => {
    if (table !== 'rule_candidates') {
      throw new Error(`fake holds only rule_candidates, not ${table}`);
    }
    return query(rows);
  });
  return { client: { from } as unknown as Client, from };
};
