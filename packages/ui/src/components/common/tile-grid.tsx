import * as React from 'react';

import { cn } from '@workspace/ui/lib/utils';

/** Gap between tiles, in rem — must match the `gap-3` class below. */
const GAP_REM = 0.75;

/**
 * How many tiles to put on a row so the rows come out even.
 *
 * Filling each row to `maxPerRow` and letting the remainder trail leaves
 * holes: four tiles at three per row reads as a full row plus a lonely one.
 * Spreading the same tiles over the rows they actually need — four become
 * 2 + 2, five become 3 + 2 — keeps every row deliberate.
 */
export const tilesPerRow = (count: number, maxPerRow: number): number => {
  if (count <= 1) return 1;
  const rows = Math.ceil(count / maxPerRow);
  return Math.ceil(count / rows);
};

export type TileGridProps = React.ComponentPropsWithoutRef<'div'> & {
  /** Upper bound per row on wide screens. Rows may come out narrower. */
  maxPerRow?: number;
};

/**
 * TileGrid — a row of equal tiles that always ends flush.
 *
 * For lists whose length VARIES: dashboard KPIs, per-scope cards, anything
 * where a tile may or may not be rendered. Two things follow from that:
 * the row width is chosen so the rows come out even (four tiles read as
 * 2 + 2, not 3 + 1), and a row holding fewer tiles than its width lets them
 * grow into the leftover space.
 *
 * Flex rather than grid, because a grid reserves its columns whether or not
 * anything occupies them — the empty slots at the end are exactly what this
 * avoids.
 *
 * NOT for fixed pairs. Two panes meant to be compared side by side (memory A
 * against memory B, export against import) should stay a plain two-column
 * grid: their count cannot vary, so there is no hole to close, and letting
 * one stretch when the other is absent would misrepresent the comparison.
 *
 * Layout mechanism only — the tiles are the children, and the count is read
 * from them, so a conditionally rendered tile changes the arrangement without
 * the caller doing any arithmetic.
 */
export function TileGrid({
  className,
  children,
  maxPerRow = 4,
  style,
  ...props
}: TileGridProps) {
  // toArray drops the nulls and falses of conditionally rendered tiles, so
  // the count is of what will actually appear.
  const tiles = React.Children.toArray(children);
  const perRow = tilesPerRow(tiles.length, maxPerRow);
  // Each tile claims its share of the row minus its share of the gaps; the
  // grow factor is what lets a short row spread across the leftover width.
  const basis = `calc(${String(100 / perRow)}% - ${String(
    (GAP_REM * (perRow - 1)) / perRow
  )}rem)`;

  return (
    <div
      className={cn('flex flex-wrap gap-3', className)}
      style={{ ...style, '--tile-basis': basis } as React.CSSProperties}
      {...props}
    >
      {tiles.map((tile, index) => (
        <div
          // Position is stable: the caller fixes which tile sits where, and
          // the list is never reordered after render.
          key={index}
          className={cn(
            'flex min-w-0 grow basis-full',
            'sm:basis-[calc(50%-0.375rem)] lg:basis-[var(--tile-basis)]',
            // The tile fills the slot it was given, so a stretched row keeps
            // its cards the same height.
            '[&>*]:w-full'
          )}
        >
          {tile}
        </div>
      ))}
    </div>
  );
}
