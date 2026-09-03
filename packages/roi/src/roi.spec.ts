import { describe, expect, it } from 'vitest';

import { DeterministicRoiJudge } from './roi-judge.js';
import { DeterministicRoiProber } from './roi-prober.js';
import type { RoiProbeCase } from './roi.schema.js';

const probeCase = (overrides: Partial<RoiProbeCase> = {}): RoiProbeCase => ({
  probeId: 'prb_x',
  question: 'What does project memory say about: the kafka port?',
  groundTruthId: 'mem_truth',
  groundTruth: 'Kafka listens on 9094 in the dev stack.',
  surfaced: [],
  ...overrides,
});

describe('DeterministicRoiProber', () => {
  it('builds one template question per memory, tagged with its id', async () => {
    const prober = new DeterministicRoiProber();
    const result = await prober.generate([
      { id: 'mem_a', content: 'Kafka listens on 9094 in the dev stack.' },
      { id: 'mem_b', content: 'We chose ltree for scopes because of RLS.' },
    ]);

    expect(result.probes).toHaveLength(2);
    expect(result.probes[0]).toMatchObject({ memory_id: 'mem_a' });
    expect(result.probes[0]?.question).toContain('Kafka listens on 9094');
    expect(result.inputTokens + result.outputTokens).toBe(0);
  });

  it('returns no probes for no memories', async () => {
    const result = await new DeterministicRoiProber().generate([]);
    expect(result.probes).toHaveLength(0);
  });
});

describe('DeterministicRoiJudge — retrieval-success lower bound', () => {
  it('marks with_memory when the ground-truth memory was surfaced', async () => {
    const { verdict } = await new DeterministicRoiJudge().judge(
      probeCase({
        surfaced: [
          { id: 'mem_other', content: 'unrelated' },
          { id: 'mem_truth', content: 'Kafka listens on 9094.' },
        ],
      })
    );

    expect(verdict).toEqual({
      with_memory: true,
      without_memory: false,
      confidence: 1,
    });
  });

  it('marks a miss when recall did not surface the ground truth', async () => {
    const { verdict } = await new DeterministicRoiJudge().judge(
      probeCase({ surfaced: [{ id: 'mem_other', content: 'unrelated' }] })
    );

    expect(verdict.with_memory).toBe(false);
    // A holdout question derives from project-specific memory: a bare agent
    // never answers it in the deterministic model.
    expect(verdict.without_memory).toBe(false);
  });
});
