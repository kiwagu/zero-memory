'use client';

import * as React from 'react';

import { Alert, AlertDescription } from '@workspace/ui/components/alert';
import { Badge } from '@workspace/ui/components/badge';
import { Button } from '@workspace/ui/components/button';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@workspace/ui/components/card';

/**
 * Memory-hygiene review surface. Mechanism only: rows and labels arrive
 * translated, the resolution is an injected callback, and the caller owns
 * pending/error state. Each item shows the conflicting pair side by side with
 * the actions a person can take.
 */

export type ReviewVerdict =
  | 'duplicate'
  | 'supersedes'
  | 'contradiction'
  // A pair the retro aperture surfaced with no opinion attached: nobody has
  // judged it, so it carries no confidence and no rationale to show.
  | 'unjudged';

export type ReviewResolutionKind =
  'keep_both' | 'forget_a' | 'forget_b' | 'supersede_a_b' | 'supersede_b_a';

export interface ReviewMemory {
  id: string;
  kind: string;
  /** Pre-formatted creation timestamp (helps judge which memory is newer). */
  created: string;
  content: string;
  /** Link to this memory's detail page (resolved by the app). */
  href: string;
}

export interface ReviewItem {
  id: string;
  verdict: ReviewVerdict;
  confidence: number | null;
  rationale: string | null;
  memoryA: ReviewMemory;
  memoryB: ReviewMemory;
}

export interface ReviewQueueLabels {
  empty: string;
  /** "Confidence {value}" — `{value}` is replaced with the score. */
  confidence: string;
  merge: string;
  verdict: Record<ReviewVerdict, string>;
  actions: Record<ReviewResolutionKind, string>;
}

const ACTION_ORDER: ReviewResolutionKind[] = [
  'supersede_a_b',
  'supersede_b_a',
  'forget_a',
  'forget_b',
  'keep_both',
];

function MemoryPane({
  label,
  memory,
  linkComponent: LinkComponent = 'a',
}: {
  label: string;
  memory: ReviewMemory;
  /** Client-router link injected by the app (e.g. next/link); plain <a> by default. */
  linkComponent?: React.ElementType;
}) {
  return (
    <div className="rounded-md border p-3">
      <div className="mb-1 flex flex-wrap items-center gap-x-2 gap-y-1">
        <Badge variant="outline">{label}</Badge>
        <span className="text-muted-foreground text-xs">{memory.kind}</span>
        <span className="text-muted-foreground text-xs">·</span>
        <LinkComponent
          href={memory.href}
          className="text-primary font-mono text-xs break-all select-all hover:underline"
          data-testid="review-memory-link"
        >
          {memory.id}
        </LinkComponent>
        <span className="text-muted-foreground text-xs">·</span>
        <span className="text-muted-foreground text-xs">{memory.created}</span>
      </div>
      <p className="text-sm">{memory.content}</p>
    </div>
  );
}

export function ReviewQueue({
  items,
  labels,
  pendingId,
  error,
  onResolve,
  onMerge,
  linkComponent,
}: {
  items: ReviewItem[];
  labels: ReviewQueueLabels;
  pendingId: string | null;
  error: string | null;
  onResolve: (id: string, resolution: ReviewResolutionKind) => void;
  onMerge: (item: ReviewItem) => void;
  /** Client-router link injected by the app (e.g. next/link); plain <a> by default. */
  linkComponent?: React.ElementType;
}) {
  if (items.length === 0) {
    return (
      <p data-testid="review-empty" className="text-muted-foreground text-sm">
        {labels.empty}
      </p>
    );
  }

  return (
    <div data-testid="review-queue" className="space-y-4">
      {error ? (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      {items.map((item) => {
        const busy = pendingId === item.id;
        return (
          <Card key={item.id} data-testid="review-item">
            <CardHeader className="flex-row items-center justify-between gap-2 space-y-0">
              <div className="space-y-0.5">
                <CardTitle className="text-base">
                  {labels.verdict[item.verdict]}
                </CardTitle>
                <p
                  className="text-muted-foreground font-mono text-xs select-all"
                  data-testid="review-item-id"
                >
                  {item.id}
                </p>
              </div>
              {item.confidence != null ? (
                <Badge variant="secondary">
                  {labels.confidence.replace(
                    '{value}',
                    item.confidence.toFixed(2)
                  )}
                </Badge>
              ) : null}
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="grid gap-3 sm:grid-cols-2">
                <MemoryPane
                  label="A"
                  memory={item.memoryA}
                  linkComponent={linkComponent}
                />
                <MemoryPane
                  label="B"
                  memory={item.memoryB}
                  linkComponent={linkComponent}
                />
              </div>
              {item.rationale ? (
                <p className="text-muted-foreground text-sm italic">
                  {item.rationale}
                </p>
              ) : null}
              <div className="flex flex-wrap gap-2">
                {ACTION_ORDER.map((action) => (
                  <Button
                    key={action}
                    size="sm"
                    variant={action === 'keep_both' ? 'ghost' : 'outline'}
                    disabled={busy}
                    data-testid={`review-resolve-${action}`}
                    onClick={() => onResolve(item.id, action)}
                  >
                    {labels.actions[action]}
                  </Button>
                ))}
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={busy}
                  data-testid="review-merge-open"
                  onClick={() => onMerge(item)}
                >
                  {labels.merge}
                </Button>
              </div>
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}
