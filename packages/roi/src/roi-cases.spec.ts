import { describe, expect, it } from 'vitest';

import { rebuildRoiCases } from './roi-cases.js';

const probe = (probeId: string, question: string) => ({
  probeId,
  question,
  groundTruthId: `mem_truth_${probeId}`,
  groundTruth: `truth of ${probeId}`,
  sourceScope: 'personal',
});

describe('rebuildRoiCases', () => {
  it('rebuilds each recalled case from its probe and the surfaced contents, in rank order', () => {
    const cases = rebuildRoiCases(
      [probe('prb_1', 'q1'), probe('prb_2', 'q2')],
      new Map([
        ['mem_a', 'content a'],
        ['mem_b', 'content b'],
      ]),
      [
        { probeId: 'prb_2', surfacedIds: ['mem_b', 'mem_a'] },
        { probeId: 'prb_1', surfacedIds: [] },
      ]
    );

    expect(cases).toEqual([
      {
        probeId: 'prb_2',
        question: 'q2',
        groundTruthId: 'mem_truth_prb_2',
        groundTruth: 'truth of prb_2',
        surfaced: [
          { id: 'mem_b', content: 'content b' },
          { id: 'mem_a', content: 'content a' },
        ],
      },
      {
        probeId: 'prb_1',
        question: 'q1',
        groundTruthId: 'mem_truth_prb_1',
        groundTruth: 'truth of prb_1',
        surfaced: [],
      },
    ]);
  });

  it('drops a probe retired since the recall, and a case whose evidence lost a memory since', () => {
    const cases = rebuildRoiCases(
      [probe('prb_1', 'q1'), probe('prb_2', 'q2')],
      new Map([['mem_a', 'content a']]),
      [
        { probeId: 'prb_gone', surfacedIds: ['mem_a'] },
        { probeId: 'prb_1', surfacedIds: ['mem_deleted', 'mem_a'] },
        { probeId: 'prb_2', surfacedIds: ['mem_a'] },
      ]
    );

    expect(cases.map((probeCase) => probeCase.probeId)).toEqual(['prb_2']);
  });
});
