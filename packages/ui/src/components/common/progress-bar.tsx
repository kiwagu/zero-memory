import * as React from 'react';

import { cn } from '@workspace/ui/lib/utils';

/**
 * A determinate progress bar with an optional caption. A null `pct` renders an
 * indeterminate pulsing sliver (work started, total unknown). Vendor-neutral:
 * all copy is passed in.
 */
export function ProgressBar({
  pct,
  label,
  className,
}: {
  pct: number | null;
  label?: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn('space-y-1', className)}
      role="progressbar"
      aria-valuenow={pct ?? undefined}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <div className="bg-foreground/10 h-2 w-full overflow-hidden rounded-full">
        <div
          className={cn(
            'bg-primary h-full transition-[width]',
            pct === null && 'w-1/3 animate-pulse'
          )}
          style={pct === null ? undefined : { width: `${pct}%` }}
        />
      </div>
      {label ? <p className="text-muted-foreground text-xs">{label}</p> : null}
    </div>
  );
}
