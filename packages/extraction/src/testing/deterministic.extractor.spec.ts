import { describe, expect, it } from 'vitest';

import { DeterministicExtractor } from './deterministic.extractor.js';

describe('DeterministicExtractor', () => {
  const extractor = new DeterministicExtractor();

  it('parses kind prefixes, confidence overrides, and directives', async () => {
    const result = await extractor.extract(
      [
        'user: 中身のない雑談',
        'DECISION: chose postgres over mysql because of ltree',
        'PREF@0.75: 短い一行のcommitメッセージ',
        'FACT: alpha uses postgres [[entity:alpha|project]] [[rel:alpha|uses|postgres]]',
        'GOTCHA: tiny', // < 8 chars after prefix -> dropped
        'assistant: more noise',
      ].join('\n')
    );

    expect(result.memories).toHaveLength(3);

    const [decision, pref, fact] = result.memories;
    expect(decision).toMatchObject({
      kind: 'decision',
      confidence: 0.9,
      content: 'chose postgres over mysql because of ltree',
    });
    expect(pref).toMatchObject({
      kind: 'preference',
      confidence: 0.75,
      content: '短い一行のcommitメッセージ',
    });
    expect(fact).toMatchObject({
      kind: 'fact',
      content: 'alpha uses postgres',
      entities: [{ name: 'alpha', type: 'project' }],
      relations: [{ src: 'alpha', type: 'uses', dst: 'postgres' }],
    });
  });

  it('returns an empty result for noise-only transcripts', async () => {
    const result = await extractor.extract('user: hi\nassistant: hello');
    expect(result.memories).toEqual([]);
  });
});
