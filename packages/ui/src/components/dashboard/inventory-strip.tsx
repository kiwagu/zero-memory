import * as React from 'react';

import { cn } from '@workspace/ui/lib/utils';

/**
 * InventoryStrip — the light inventory row above the KPI grid: store totals
 * (memories / entities / scopes) with optional growth deltas, plus a trailing
 * freshness note ("Last capture 3m ago"). Deliberately quieter than the
 * MetricStat cards: inventory is context, not a KPI. Mechanism only — every
 * string arrives formatted from the caller so i18n stays in the app.
 */

export type InventoryItem = {
  key: string;
  label: string;
  value: string;
  /** Preformatted growth note, e.g. "+12 in 24h"; omitted when zero. */
  delta?: string;
};

export function InventoryStrip({
  items,
  freshness,
  className,
  ...props
}: React.ComponentPropsWithoutRef<'div'> & {
  items: InventoryItem[];
  /** Preformatted freshness stamp, e.g. "Last capture 3m ago". */
  freshness?: string;
}) {
  return (
    <div
      className={cn(
        'flex flex-wrap items-center gap-x-8 gap-y-2 rounded-xl border px-4 py-3',
        className
      )}
      {...props}
    >
      {items.map((item) => (
        <div key={item.key} className="flex items-baseline gap-2">
          <span className="text-lg font-semibold tabular-nums">
            {item.value}
          </span>
          <span className="text-muted-foreground text-sm">{item.label}</span>
          {item.delta ? (
            <span className="text-chart-2 text-xs font-medium">
              {item.delta}
            </span>
          ) : null}
        </div>
      ))}
      {freshness ? (
        <span className="text-muted-foreground ml-auto text-xs">
          {freshness}
        </span>
      ) : null}
    </div>
  );
}
