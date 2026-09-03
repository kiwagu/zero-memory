import { Languages } from 'lucide-react';
import * as React from 'react';

import {
  BadgeList,
  type BadgeListItem,
  type BadgeListVariant,
} from '@workspace/ui/components/common/badge-list';
import { cn } from '@workspace/ui/lib/utils';

/** The original-language source to reveal under a card, display-ready. */
export interface MemoryOriginal {
  text: string;
  lang: string | null;
  /** Toggle label, e.g. "Original (ja)". */
  label: string;
}

/** Relevance of a ranked-search hit, display-ready. */
export interface MemoryScore {
  /** Relative to the top hit (top-1 = 100). */
  pct: number;
  /** Badge text, e.g. "97%". */
  label: string;
  /** Raw-score explanation shown on hover, e.g. "Fused score: 0.0312". */
  rawLabel: string;
  /**
   * Absolute closeness band — the rank-relative pct alone cannot tell a
   * strong match from rank-one-of-nothing. Omitted for text-only hits.
   */
  quality?: { label: string; tone: 'green' | 'amber' | 'muted' };
  /** Chip label when the full-text leg matched (e.g. "text match"). */
  textMatch?: string;
}

// Mirrors the Badge green/amber variants so the quality chip reads as one
// vocabulary with the card badges.
const QUALITY_TONES = {
  green: 'bg-green-100 text-green-700 dark:bg-green-500/15 dark:text-green-400',
  amber: 'bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-400',
  muted: 'bg-muted text-muted-foreground',
} as const;

/**
 * MemoryCard — the feed unit of the dashboard. Pure presentation: content,
 * badges and the timestamp arrive display-ready (i18n and data mapping stay
 * in the app), navigation goes through the injected link component.
 */

type MemoryBadgeVariant = BadgeListVariant;

type MemoryBadgeItem = BadgeListItem;

const MemoryBadges = BadgeList;

const CONTENT_PREVIEW_LENGTH = 400;

interface MemoryCardProps {
  content: string;
  href: string;
  badges: MemoryBadgeItem[];
  /** The memory's id, shown as a mono label so the card is identifiable. */
  memoryId?: string;
  /** Preformatted, locale-stable timestamp string. */
  timestamp: string;
  /** Dimmed rendering for invalidated memories. */
  muted?: boolean;
  /** Original-language source to reveal; omitted for born-English memories. */
  original?: MemoryOriginal;
  /** Relevance of a ranked-search hit; omitted in the chronological feed. */
  score?: MemoryScore;
  /** Client-router link injected by the app (e.g. next/link); plain <a> by default. */
  linkComponent?: React.ElementType;
  /** Stable e2e selector rendered onto the card root. */
  'data-testid'?: string;
}

function MemoryCard({
  content,
  href,
  badges,
  memoryId,
  timestamp,
  muted = false,
  original,
  score,
  linkComponent: LinkComponent = 'a',
  'data-testid': testId,
}: MemoryCardProps) {
  // The original-language reveal splits its toggle (a header corner) from its
  // text (a full-width block below the content) so opening it never widens the
  // header — the two are wired by a CSS `peer` checkbox, no client JS. Needs a
  // stable unique id, so it rides on the memory id (always present in the feed).
  const revealId = original && memoryId ? `memory-original-${memoryId}` : null;
  return (
    <article
      data-testid={testId}
      className={cn(
        'rounded-xl border bg-card p-4 text-card-foreground shadow-sm',
        muted && 'opacity-60'
      )}
    >
      {revealId ? (
        <input type="checkbox" id={revealId} className="peer sr-only" />
      ) : null}
      {memoryId || original || score ? (
        <div className="mb-2 flex items-start justify-between gap-2">
          {memoryId ? (
            <div
              data-testid="memory-id"
              className="min-w-0 font-mono text-xs break-all text-muted-foreground select-all"
            >
              {memoryId}
            </div>
          ) : null}
          {score ? (
            // Native title keeps the raw-score reveal JS-free, matching the
            // card's CSS-only interaction budget.
            <span
              data-testid="memory-score"
              title={score.rawLabel}
              className="inline-flex shrink-0 items-center gap-1.5"
            >
              {score.quality ? (
                <span
                  data-testid="memory-match-quality"
                  className={cn(
                    'rounded-full px-1.5 py-0.5 text-[10px] font-medium',
                    QUALITY_TONES[score.quality.tone]
                  )}
                >
                  {score.quality.label}
                </span>
              ) : null}
              {score.textMatch ? (
                <span
                  data-testid="memory-text-match"
                  className="rounded-full bg-blue-100 px-1.5 py-0.5 text-[10px] font-medium text-blue-700 dark:bg-blue-500/15 dark:text-blue-400"
                >
                  {score.textMatch}
                </span>
              ) : null}
              <span className="h-1.5 w-12 overflow-hidden rounded-full bg-foreground/10">
                <span
                  className="block h-full bg-primary"
                  style={{ width: `${Math.max(0, Math.min(100, score.pct))}%` }}
                />
              </span>
              <span className="text-xs font-medium text-muted-foreground tabular-nums">
                {score.label}
              </span>
            </span>
          ) : null}
          {revealId && original ? (
            <label
              htmlFor={revealId}
              data-testid="memory-original-toggle"
              className="ml-auto inline-flex shrink-0 cursor-pointer items-center gap-1 text-xs text-muted-foreground transition-colors select-none hover:text-foreground"
            >
              <Languages className="size-3.5" aria-hidden />
              {original.label}
            </label>
          ) : null}
        </div>
      ) : null}
      <LinkComponent
        href={href}
        className="block text-sm whitespace-pre-wrap hover:underline"
      >
        {content.length > CONTENT_PREVIEW_LENGTH
          ? `${content.slice(0, CONTENT_PREVIEW_LENGTH)}…`
          : content}
      </LinkComponent>
      {revealId && original ? (
        <div
          data-testid="memory-original-text"
          lang={original.lang ?? undefined}
          className="mt-2 hidden rounded-md bg-muted p-3 text-xs break-words whitespace-pre-wrap text-muted-foreground peer-checked:block"
        >
          {original.text}
        </div>
      ) : null}
      <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
        <MemoryBadges badges={badges} />
        <time className="text-xs text-muted-foreground">{timestamp}</time>
      </div>
    </article>
  );
}

export {
  MemoryBadges,
  MemoryCard,
  type MemoryBadgeItem,
  type MemoryBadgeVariant,
  type MemoryCardProps,
};
