import * as React from 'react';

import { Card, CardContent } from '@workspace/ui/components/card';
import { Sparkline } from '@workspace/ui/components/dashboard/sparkline';
import { cn } from '@workspace/ui/lib/utils';

/**
 * MetricStat — one KPI tile for the value dashboard: a big value, a muted label,
 * an optional hint line (e.g. "1 of 2 briefings"), an optional share bar, and an
 * optional daily-trend sparkline. Mechanism only — every string (label,
 * formatted value, hint) is supplied by the caller so i18n and number formatting
 * stay in the app. Semantic tokens only → dark mode automatic.
 */

/** A filled share of a whole, for the tiles whose value has a ceiling. */
export interface MetricStatProgress {
  value: number;
  max: number;
  /** Accessible name — the caller owns every string, including this one. */
  label: string;
}

export type MetricStatProps = React.ComponentPropsWithoutRef<'div'> & {
  label: string;
  value: string;
  hint?: string;
  /** Per-day values for the tile's trend sparkline (>= 2 points to render). */
  trend?: number[];
  progress?: MetricStatProgress;
};

export function MetricStat({
  label,
  value,
  hint,
  trend,
  progress,
  className,
  ...props
}: MetricStatProps) {
  // A share past 100% is real — checking and spending are not atomic, so a
  // ceiling can be passed. The BAR is clamped so it cannot overflow its track,
  // while the announced value stays the true one.
  const filled =
    progress && progress.max > 0
      ? Math.min(100, Math.max(0, (progress.value / progress.max) * 100))
      : 0;
  const over = progress ? progress.value >= progress.max : false;

  return (
    <Card className={cn('gap-0', className)} {...props}>
      <CardContent className="space-y-1">
        <p className="text-muted-foreground text-sm">{label}</p>
        <p className="text-2xl font-semibold tabular-nums">{value}</p>
        {progress ? (
          <div
            data-testid="metric-stat-progress"
            role="progressbar"
            aria-label={progress.label}
            aria-valuenow={progress.value}
            aria-valuemin={0}
            aria-valuemax={progress.max}
            className="bg-muted mt-2 h-1.5 w-full overflow-hidden rounded-full"
          >
            <div
              className={cn(
                'h-full rounded-full transition-[width]',
                over ? 'bg-destructive' : 'bg-chart-2'
              )}
              style={{ width: `${String(filled)}%` }}
            />
          </div>
        ) : null}
        {hint ? <p className="text-muted-foreground text-xs">{hint}</p> : null}
        {trend ? (
          <Sparkline values={trend} className="text-chart-2 mt-2" />
        ) : null}
      </CardContent>
    </Card>
  );
}
