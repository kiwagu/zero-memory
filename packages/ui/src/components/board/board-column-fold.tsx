'use client';

import { ChevronDownIcon, ChevronLeftIcon } from 'lucide-react';
import * as React from 'react';

import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@workspace/ui/components/tooltip';

/**
 * BoardColumnFold — one column of the board with the cards that went quiet
 * past the horizon folded away.
 *
 * The arrow in the right of the header is both the control and the signal:
 * it is there only when the column holds such cards, points left while they
 * are folded and down once they are open, and its hint says how many there are
 * and why they are folded. The tiles arrive already rendered, so the column
 * stays a window on the store: the only state here is whether the fold is open.
 */
function BoardColumnFold({
  columnKey,
  header,
  recent,
  recentCount,
  older,
  olderCount,
  olderHints,
}: {
  columnKey: string;
  /** The state pill that names the column. */
  header: React.ReactNode;
  recent: React.ReactNode;
  recentCount: number;
  older?: React.ReactNode;
  olderCount: number;
  /** What the arrow says, folded and open: how many, and why. */
  olderHints?: { show: string; hide: string };
}) {
  const [open, setOpen] = React.useState(false);
  const hint = open ? olderHints?.hide : olderHints?.show;

  return (
    <section
      className="flex min-w-64 flex-1 basis-0 flex-col gap-3"
      data-testid={`board-column-${columnKey}`}
    >
      <div className="flex items-center justify-between">
        {header}
        <div className="flex items-center gap-1">
          <span className="text-muted-foreground text-xs tabular-nums">
            {open ? recentCount + olderCount : recentCount}
          </span>
          {olderCount > 0 && hint ? (
            <Tooltip>
              <TooltipTrigger
                aria-label={hint}
                aria-expanded={open}
                data-testid="board-column-older-toggle"
                onClick={() => setOpen((was) => !was)}
                className="text-muted-foreground hover:text-foreground focus-visible:ring-ring inline-flex rounded-sm focus-visible:ring-2 focus-visible:outline-none"
              >
                {open ? (
                  <ChevronDownIcon className="size-4" aria-hidden />
                ) : (
                  <ChevronLeftIcon className="size-4" aria-hidden />
                )}
              </TooltipTrigger>
              <TooltipContent
                className="max-w-xs"
                data-testid="board-column-older-hint"
              >
                {hint}
              </TooltipContent>
            </Tooltip>
          ) : null}
        </div>
      </div>

      {recent}

      {open && older ? (
        <div className="flex flex-col gap-3" data-testid="board-column-older">
          {older}
        </div>
      ) : null}
    </section>
  );
}

export { BoardColumnFold };
