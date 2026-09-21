import * as React from 'react';

import { Badge } from '@workspace/ui/components/badge';
import { EmptyState } from '@workspace/ui/components/common/empty-state';

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
  /** An author's statement, with how it stands to the one it answers. */
  note?: { text: string; relationLabel?: string };
  /** What was attached or detached, as kind and target. */
  refLabel?: string;
}

function CardHistory({
  entries,
  emptyLabel,
}: {
  entries: CardHistoryEntry[];
  emptyLabel: string;
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
            <p className="text-foreground/90 italic" data-testid="card-reason">
              {entry.reason}
            </p>
          ) : null}

          {entry.note ? (
            <p className="whitespace-pre-wrap" data-testid="card-note">
              {entry.note.relationLabel ? (
                <Badge variant="ghost" className="mr-2 text-[11px]">
                  {entry.note.relationLabel}
                </Badge>
              ) : null}
              {entry.note.text}
            </p>
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
