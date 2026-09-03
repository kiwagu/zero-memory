'use client';

import { Area, AreaChart } from 'recharts';

import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@workspace/ui/components/card';
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from '@workspace/ui/components/chart';

/**
 * MiniAreaChart — one small, single-series area chart for the dashboard's
 * small-multiples row. Each renders a single flow metric's daily shape (a
 * period total on top). Presentational; the design-system chart token keeps
 * themes automatic.
 */
export function MiniAreaChart({
  title,
  total,
  data,
  seriesKey,
  seriesLabel,
  ...props
}: React.ComponentPropsWithoutRef<typeof Card> & {
  title: string;
  total: string;
  data: Array<Record<string, unknown>>;
  seriesKey: string;
  seriesLabel: string;
}) {
  const config = {
    [seriesKey]: { label: seriesLabel, color: 'var(--chart-2)' },
  } satisfies ChartConfig;

  return (
    <Card {...props}>
      <CardHeader className="pb-0">
        <CardTitle className="text-muted-foreground text-sm font-normal">
          {title}
        </CardTitle>
        <p className="text-xl font-semibold tabular-nums">{total}</p>
      </CardHeader>
      <CardContent className="pt-2">
        <ChartContainer config={config} className="aspect-auto h-[64px] w-full">
          <AreaChart data={data} margin={{ left: 0, right: 0, top: 4 }}>
            <defs>
              <linearGradient
                id={`fillMini-${seriesKey}`}
                x1="0"
                y1="0"
                x2="0"
                y2="1"
              >
                <stop
                  offset="5%"
                  stopColor={`var(--color-${seriesKey})`}
                  stopOpacity={0.7}
                />
                <stop
                  offset="95%"
                  stopColor={`var(--color-${seriesKey})`}
                  stopOpacity={0.05}
                />
              </linearGradient>
            </defs>
            <ChartTooltip content={<ChartTooltipContent hideLabel />} />
            <Area
              dataKey={seriesKey}
              type="natural"
              fill={`url(#fillMini-${seriesKey})`}
              stroke={`var(--color-${seriesKey})`}
              strokeWidth={1.5}
            />
          </AreaChart>
        </ChartContainer>
      </CardContent>
    </Card>
  );
}
