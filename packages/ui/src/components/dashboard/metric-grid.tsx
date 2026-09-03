import {
  TileGrid,
  type TileGridProps,
} from '@workspace/ui/components/common/tile-grid';

/**
 * MetricGrid — the value dashboard's KPI tiles.
 *
 * The dashboard's name for the general {@link TileGrid}: the arrangement
 * rules (even rows, last row flush) are not specific to KPIs, so they live in
 * the shared primitive and any other variable-length tile list gets them too.
 */
export function MetricGrid(props: TileGridProps) {
  return <TileGrid {...props} />;
}
