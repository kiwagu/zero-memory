import type { WebTranslator } from '@workspace/i18n-catalogs/web';
import { describe, expect, it } from 'vitest';

import type { RecallHit } from './mcp';
import {
  DEFAULT_TOP_K,
  MAX_TOP_K,
  clampTopK,
  matchQuality,
  normalizeScores,
  parseKindsParam,
  searchHitCardProps,
} from './recall';

/** Key-echoing translator: `key` or `key{varsJson}` — asserts keys, not copy. */
const t: WebTranslator = (key, vars) =>
  vars ? `${key}${JSON.stringify(vars)}` : key;

function hit(overrides: Partial<RecallHit> = {}): RecallHit {
  return {
    id: 'mem_abc123def456ghij.0000000001',
    content: 'Token price is a constant by default.',
    kind: 'decision',
    scope: 'proj.zero_memory',
    visibility: 'private',
    created_at: '2026-07-10T07:40:50.773+00:00',
    score: 0.0321,
    disputed: false,
    dispute_id: null,
    dispute_with: null,
    similarity: 0.87,
    fts_matched: false,
    ...overrides,
  };
}

describe('clampTopK', () => {
  it('defaults, clamps to the ceiling, and rejects garbage', () => {
    expect(clampTopK(undefined)).toBe(DEFAULT_TOP_K);
    expect(clampTopK('')).toBe(DEFAULT_TOP_K);
    expect(clampTopK('0')).toBe(DEFAULT_TOP_K);
    expect(clampTopK('-3')).toBe(DEFAULT_TOP_K);
    expect(clampTopK('abc')).toBe(DEFAULT_TOP_K);
    expect(clampTopK('25')).toBe(25);
    expect(clampTopK('500')).toBe(MAX_TOP_K);
  });
});

describe('parseKindsParam', () => {
  it('keeps only known kinds, in canonical order', () => {
    expect(parseKindsParam(undefined)).toEqual([]);
    expect(parseKindsParam('gotcha,decision')).toEqual(['decision', 'gotcha']);
    expect(parseKindsParam('nope, decision ,')).toEqual(['decision']);
  });
});

describe('matchQuality', () => {
  it('bands similarity and skips text-only hits', () => {
    expect(matchQuality(0.9)).toBe('strong');
    expect(matchQuality(0.85)).toBe('strong');
    expect(matchQuality(0.82)).toBe('medium');
    expect(matchQuality(0.79)).toBe('weak');
    expect(matchQuality(null)).toBeUndefined();
  });
});

describe('normalizeScores', () => {
  it('scales relative to the top hit and preserves order', () => {
    const scored = normalizeScores([
      hit({ score: 0.04 }),
      hit({ score: 0.03 }),
      hit({ score: 0.01 }),
    ]);
    expect(scored.map((s) => s.scorePct)).toEqual([100, 75, 25]);
  });

  it('is safe on empty input and zero scores', () => {
    expect(normalizeScores([])).toEqual([]);
    expect(normalizeScores([hit({ score: 0 })])[0]!.scorePct).toBe(0);
  });
});

describe('searchHitCardProps', () => {
  it('maps a hit to card props with a score badge', () => {
    const [scored] = normalizeScores([hit()]);
    const props = searchHitCardProps(scored!, t);
    expect(props.href).toBe('/memory/mem_abc123def456ghij.0000000001');
    expect(props.badges.map((badge) => badge.label)).toEqual([
      'kind.decision',
      'visibility.private',
      'proj.zero_memory',
    ]);
    expect(props.score).toEqual({
      pct: 100,
      label: 'memory.score{"pct":100}',
      rawLabel:
        'memory.scoreRaw{"score":"0.0321"} · memory.similarityRaw{"sim":"0.870"}',
      quality: { label: 'memory.match.strong', tone: 'green' },
      textMatch: undefined,
    });
  });

  it('marks a text-leg match and omits quality for text-only hits', () => {
    const [scored] = normalizeScores([
      hit({ similarity: null, fts_matched: true }),
    ]);
    const score = searchHitCardProps(scored!, t).score!;
    expect(score.quality).toBeUndefined();
    expect(score.textMatch).toBe('memory.match.text');
    expect(score.rawLabel).toBe('memory.scoreRaw{"score":"0.0321"}');
  });

  it('adds a destructive disputed badge when the hit is disputed', () => {
    const [scored] = normalizeScores([hit({ disputed: true })]);
    const disputed = searchHitCardProps(scored!, t).badges.at(-1);
    expect(disputed).toEqual({
      label: 'memory.disputed',
      variant: 'destructive',
      testId: 'memory-disputed-badge',
    });
  });
});
