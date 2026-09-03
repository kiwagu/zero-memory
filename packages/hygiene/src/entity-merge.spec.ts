import { describe, expect, it } from 'vitest';

import {
  canonicalNameKey,
  clusterEntities,
  dominantType,
  pickCanonical,
  type EntityNode,
} from './entity-merge.js';

const node = (overrides: Partial<EntityNode>): EntityNode => ({
  id: 'ent_1',
  name: 'zero-memory',
  type: 'project',
  scope: 'proj.alpha',
  created_at: '2026-07-01T00:00:00Z',
  degree: 0,
  ...overrides,
});

describe('canonicalNameKey', () => {
  it('unifies case and separator runs', () => {
    expect(canonicalNameKey('Zero Memory')).toBe('zero-memory');
    expect(canonicalNameKey('zero_memory')).toBe('zero-memory');
    expect(canonicalNameKey('  zero -_ memory ')).toBe('zero-memory');
    expect(canonicalNameKey('postgres')).toBe('postgres');
  });
});

describe('pickCanonical', () => {
  it('prefers connectivity, then age, then id', () => {
    const busy = node({ id: 'ent_b', degree: 9, created_at: '2026-07-05' });
    const oldest = node({ id: 'ent_a', degree: 2, created_at: '2026-07-01' });
    expect(pickCanonical([oldest, busy]).id).toBe('ent_b');

    const tiedOld = node({ id: 'ent_c', degree: 9, created_at: '2026-07-01' });
    expect(pickCanonical([busy, tiedOld]).id).toBe('ent_c');
  });
});

describe('dominantType', () => {
  it('takes the most frequent type, ties resolve to the canonical', () => {
    const canonical = node({ id: 'ent_a', type: 'project' });
    const members = [
      canonical,
      node({ id: 'ent_b', type: 'repo' }),
      node({ id: 'ent_c', type: 'repo' }),
    ];
    expect(dominantType(members, canonical)).toBe('repo');

    const tied = [canonical, node({ id: 'ent_d', type: 'repo' })];
    expect(dominantType(tied, canonical)).toBe('project');
  });
});

describe('clusterEntities', () => {
  it('groups spelling variants inside one scope, never across scopes', () => {
    const clusters = clusterEntities([
      node({ id: 'ent_1', name: 'zero-memory', degree: 5 }),
      node({ id: 'ent_2', name: 'zero_memory', type: 'repo' }),
      node({ id: 'ent_3', name: 'Zero Memory', type: 'service' }),
      // Same name, other scope: isolated, no cluster.
      node({ id: 'ent_4', name: 'zero-memory', scope: 'user.someone' }),
      // Unique name: no cluster.
      node({ id: 'ent_5', name: 'postgres' }),
    ]);

    expect(clusters).toHaveLength(1);
    const [cluster] = clusters;
    expect(cluster!.canonical.id).toBe('ent_1');
    expect(cluster!.duplicates.map((d) => d.id).sort()).toEqual([
      'ent_2',
      'ent_3',
    ]);
    expect(cluster!.key).toBe('zero-memory');
  });
});
