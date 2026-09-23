import * as React from 'react';

import { Badge } from '@workspace/ui/components/badge';
import { EmptyState } from '@workspace/ui/components/common/empty-state';
import { Markdown } from '@workspace/ui/components/common/markdown';

/**
 * CardHistory — a card's append-only stream: what happened, who wrote it, and
 * the reason a move carried.
 *
 * The reason is never truncated. It is the record's whole value: a reader
 * three weeks later has it instead of reconstructing why a column changed.
 * Display-only — every label arrives translated from the app.
 */

interface CardHistoryEntry {
  id: string;
  /** Position in the stream, already formatted. */
  seqLabel: string;
  typeLabel: string;
  /** `Idea → Active`, when the entry is a move. */
  transitionLabel?: string;
  actorLabel: string;
  timeLabel: string;
  reason?: string;
  /** What the mover declared in place of the branch rule. */
  declaration?: { label: string; text: string };
  /** An author's statement, with how it stands to the one it answers. */
  note?: { text: string; relationLabel?: string };
  /** What was attached or detached, as kind and target. */
  refLabel?: string;
}

function CardHistory({
  entries,
  emptyLabel,
  linkComponent = 'a',
}: {
  entries: CardHistoryEntry[];
  emptyLabel: string;
  /** Client-router link injected by the app (e.g. next/link); plain <a> by default. */
  linkComponent?: React.ElementType;
}) {
  if (entries.length === 0) {
    return <EmptyState compact>{emptyLabel}</EmptyState>;
  }

  return (
    <ol className="flex flex-col gap-3" data-testid="card-history">
      {entries.map((entry) => (
        <li key={entry.id} className="flex flex-col gap-1 text-sm">
          <div className="text-muted-foreground flex flex-wrap items-center gap-2 text-xs">
            <span className="tabular-nums">{entry.seqLabel}</span>
            <span className="text-foreground font-medium">
              {entry.typeLabel}
            </span>
            {entry.transitionLabel ? (
              <span>{entry.transitionLabel}</span>
            ) : null}
            <span>{entry.actorLabel}</span>
            <span>{entry.timeLabel}</span>
          </div>

          {entry.reason ? (
            <div
              className="text-foreground/90 italic"
              data-testid="card-reason"
            >
              <Markdown density="inline" linkComponent={linkComponent}>
                {entry.reason}
              </Markdown>
            </div>
          ) : null}

          {entry.declaration ? (
            <p className="text-sm" data-testid="card-declaration">
              <span className="text-muted-foreground">
                {entry.declaration.label}
              </span>{' '}
              {entry.declaration.text}
            </p>
          ) : null}

          {entry.note ? (
            <div className="flex items-start gap-2" data-testid="card-note">
              {entry.note.relationLabel ? (
                <Badge variant="ghost" className="text-[11px]">
                  {entry.note.relationLabel}
                </Badge>
              ) : null}
              <Markdown linkComponent={linkComponent}>
                {entry.note.text}
              </Markdown>
            </div>
          ) : null}

          {entry.refLabel ? (
            <p className="text-muted-foreground font-mono text-xs">
              {entry.refLabel}
            </p>
          ) : null}
        </li>
      ))}
    </ol>
  );
}

export { CardHistory, type CardHistoryEntry };
