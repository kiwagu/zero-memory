import { describe, expect, it } from 'vitest';

import { rowsOf } from './query';

describe('rowsOf', () => {
  it('returns the rows of a query that succeeded', () => {
    expect(rowsOf({ data: [1, 2], error: null }, 'links')).toEqual([1, 2]);
  });

  it('keeps "nothing found" as null, not as a failure', () => {
    expect(rowsOf({ data: null, error: null }, 'memory')).toBeNull();
  });

  it('throws when the query failed, instead of reading as empty', () => {
    expect(() =>
      rowsOf({ data: null, error: { message: 'connection reset' } }, 'memory')
    ).toThrow('memory: connection reset');
  });
});
