import type { WebTranslator } from '@workspace/i18n-catalogs/web';
import type { MemoryCardProps } from '@workspace/ui/components/memory/memory-card';

import {
  MEMORY_KINDS,
  formatTimestamp,
  kindLabel,
  memoryHref,
  scopeLabel,
  sharingBadge,
} from './memory';
import type { RecallHit } from './mcp';

/** Ranked-search result size: default and the hard UI ceiling. */
export const DEFAULT_TOP_K = 10;
export const MAX_TOP_K = 50;
export const TOP_K_OPTIONS = [5, 10, 25, 50];

/** Parses a top-k URL param into the accepted range. */
export function clampTopK(raw: string | undefined): number {
  const parsed = Number.parseInt(raw ?? '', 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return DEFAULT_TOP_K;
  }
  return Math.min(parsed, MAX_TOP_K);
}

/** Parses the comma-separated kinds URL param, dropping unknown kinds. */
export function parseKindsParam(raw: string | undefined): string[] {
  if (!raw) {
    return [];
  }
  const requested = new Set(raw.split(',').map((value) => value.trim()));
  return MEMORY_KINDS.filter((kind) => requested.has(kind));
}

export type ScoredRecallHit = RecallHit & {
  /** Relevance relative to the top hit (top-1 = 100). */
  scorePct: number;
};

export type MatchQuality = 'strong' | 'medium' | 'weak';

/**
 * Provisional e5-large-v2 query-passage thresholds, calibrated against the
 * live cosine spread (unrelated background ~0.71–0.80, related ≥ ~0.85).
 * The raw similarity stays visible on hover, so these bands are tunable by
 * eye without re-deriving anything.
 */
const STRONG_SIMILARITY = 0.85;
const MEDIUM_SIMILARITY = 0.81;

/** Absolute closeness band of a hit; undefined for text-only hits. */
export function matchQuality(
  similarity: number | null
): MatchQuality | undefined {
  if (similarity === null) {
    return undefined;
  }
  if (similarity >= STRONG_SIMILARITY) {
    return 'strong';
  }
  return similarity >= MEDIUM_SIMILARITY ? 'medium' : 'weak';
}

/**
 * Normalizes fused RRF scores for display: the raw values (~0.01) carry rank,
 * not meaning, so each hit is shown relative to the top-1 hit. Hit order is
 * the server's ranking and must be preserved as-is.
 */
export function normalizeScores(hits: RecallHit[]): ScoredRecallHit[] {
  const top = hits[0]?.score ?? 0;
  return hits.map((hit) => ({
    ...hit,
    scorePct: top > 0 ? Math.round((100 * hit.score) / top) : 0,
  }));
}

/** RecallHit → display-ready props of the vendor-neutral MemoryCard. */
export function searchHitCardProps(
  hit: ScoredRecallHit,
  t: WebTranslator,
  memberCount?: number,
  backTo?: string
): Omit<MemoryCardProps, 'linkComponent'> {
  const badges: MemoryCardProps['badges'] = [
    { label: kindLabel(hit.kind, t), variant: 'blue' },
    sharingBadge(hit.visibility, memberCount, t),
    { label: scopeLabel(hit.scope), variant: 'amber' },
  ];
  if (hit.disputed) {
    badges.push({
      label: t('memory.disputed'),
      variant: 'destructive',
      testId: 'memory-disputed-badge',
    });
  }
  const quality = matchQuality(hit.similarity);
  const rawParts = [t('memory.scoreRaw', { score: hit.score.toFixed(4) })];
  if (hit.similarity !== null) {
    rawParts.push(
      t('memory.similarityRaw', { sim: hit.similarity.toFixed(3) })
    );
  }
  return {
    content: hit.content,
    href: memoryHref(hit.id, backTo),
    badges,
    memoryId: hit.id,
    timestamp: formatTimestamp(hit.created_at),
    score: {
      pct: hit.scorePct,
      label: t('memory.score', { pct: hit.scorePct }),
      rawLabel: rawParts.join(' · '),
      quality: quality && {
        label: qualityLabel(quality, t),
        tone: ({ strong: 'green', medium: 'amber', weak: 'muted' } as const)[
          quality
        ],
      },
      textMatch: hit.fts_matched ? t('memory.match.text') : undefined,
    },
  };
}

/** Literal keys only (lint-enforced): dynamic `t(\`…${…}\`)` is banned. */
function qualityLabel(quality: MatchQuality, t: WebTranslator): string {
  switch (quality) {
    case 'strong':
      return t('memory.match.strong');
    case 'medium':
      return t('memory.match.medium');
    case 'weak':
      return t('memory.match.weak');
  }
}
