import { describe, expect, it } from 'vitest';

import { TRAVERSE_MAX_DEPTH, traverseParamsSchema } from './graph.service.js';

const START = 'ent_0000000000000001.0000000000';

describe('traverseParamsSchema', () => {
  it('defaults the depth to 2', () => {
    const params = traverseParamsSchema.parse({ startEntityId: START });
    expect(params.maxDepth).toBe(2);
    expect(params.edgeTypes).toBeUndefined();
  });

  it('accepts depths up to the hard cap and known edge types', () => {
    const params = traverseParamsSchema.parse({
      startEntityId: START,
      maxDepth: TRAVERSE_MAX_DEPTH,
      edgeTypes: ['uses', 'prefers'],
    });
    expect(params.maxDepth).toBe(3);
    expect(params.edgeTypes).toEqual(['uses', 'prefers']);
  });

  it('rejects depths beyond the cap, zero depth, and unknown edge types', () => {
    expect(
      traverseParamsSchema.safeParse({ startEntityId: START, maxDepth: 4 })
        .success
    ).toBe(false);
    expect(
      traverseParamsSchema.safeParse({ startEntityId: START, maxDepth: 0 })
        .success
    ).toBe(false);
    expect(
      traverseParamsSchema.safeParse({
        startEntityId: START,
        edgeTypes: ['friends_with'],
      }).success
    ).toBe(false);
  });

  it('rejects a non-uuid start entity', () => {
    expect(
      traverseParamsSchema.safeParse({ startEntityId: 'alpha' }).success
    ).toBe(false);
  });
});
