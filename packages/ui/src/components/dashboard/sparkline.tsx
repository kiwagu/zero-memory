import * as React from 'react';

import { cn } from '@workspace/ui/lib/utils';

/**
 * Sparkline — a tiny, dependency-free inline trend line (hand-rolled SVG). Used
 * under KPI tiles to give each metric temporal context without a full chart.
 * Stroke is `currentColor`, so the caller tints it with a `text-*` class; the
 * line is normalised to the value range and stretches to the container width.
 */
export function Sparkline({
  values,
  className,
  ...props
}: Omit<React.ComponentPropsWithoutRef<'svg'>, 'children' | 'values'> & {
  values: number[];
}) {
  if (values.length < 2) {
    return null;
  }

  const max = Math.max(...values);
  const min = Math.min(...values);
  const range = max - min || 1;
  const lastIndex = values.length - 1;

  const points = values
    .map((value, index) => {
      const x = (index / lastIndex) * 100;
      // Leave a 2px cap top/bottom so the peak/trough are not clipped.
      const y = 22 - ((value - min) / range) * 20;
      return `${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(' ');

  return (
    <svg
      viewBox="0 0 100 24"
      preserveAspectRatio="none"
      className={cn('h-6 w-full', className)}
      aria-hidden="true"
      {...props}
    >
      <polyline
        points={points}
        fill="none"
        stroke="currentColor"
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}
