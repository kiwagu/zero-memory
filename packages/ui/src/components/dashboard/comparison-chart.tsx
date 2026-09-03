'use client';

import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from 'recharts';

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@workspace/ui/components/card';
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from '@workspace/ui/components/chart';
import { EmptyState } from '@workspace/ui/components/common/empty-state';

/** One day of the compounding-context series (a cumulative value). */
export type ComparisonPoint = {
  date: string;
  value: number;
};

/**
 * ComparisonChart — the value dashboard's hero: context that COMPOUNDS across
 * sessions instead of resetting. A single cumulative area (a memoryless
 * baseline would be a flat zero line, so it is not plotted — the rising curve
 * is the whole story). Presentational: strings/locale from the caller;
 * design-system tokens so themes are automatic.
 */
export function ComparisonChart({
  title,
  description,
  data,
  locale,
  emptyLabel,
  ...props
}: React.ComponentPropsWithoutRef<typeof Card> & {
  title: string;
  description: string;
  data: ComparisonPoint[];
  locale: string;
  emptyLabel: string;
}) {
  const config = {
    value: { label: title, color: 'var(--chart-2)' },
  } satisfies ChartConfig;

  // Formatting stays in this client component: a function prop cannot cross the
  // server -> client boundary, so the caller passes `locale`, not a formatter.
  const dateFormat = new Intl.DateTimeFormat(locale, {
    month: 'short',
    day: 'numeric',
  });
  const formatDay = (value: string): string =>
    dateFormat.format(new Date(`${value}T00:00:00`));

  const peak = data.reduce((max, point) => Math.max(max, point.value), 0);

  return (
    <Card {...props}>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent>
        {peak > 0 ? (
          <ChartContainer
            config={config}
            className="aspect-auto h-[260px] w-full"
          >
            <AreaChart data={data} margin={{ left: 12, right: 12 }}>
              <defs>
                <linearGradient id="fillCompounded" x1="0" y1="0" x2="0" y2="1">
                  <stop
                    offset="5%"
                    stopColor="var(--color-value)"
                    stopOpacity={0.8}
                  />
                  <stop
                    offset="95%"
                    stopColor="var(--color-value)"
                    stopOpacity={0.1}
                  />
                </linearGradient>
              </defs>
              <CartesianGrid vertical={false} />
              <XAxis
                dataKey="date"
                tickLine={false}
                axisLine={false}
                tickMargin={8}
                minTickGap={24}
                tickFormatter={formatDay}
              />
              <YAxis hide />
              <ChartTooltip
                content={
                  <ChartTooltipContent
                    labelFormatter={(value) => formatDay(String(value))}
                  />
                }
              />
              <Area
                dataKey="value"
                type="monotone"
                fill="url(#fillCompounded)"
                stroke="var(--color-value)"
                strokeWidth={2}
              />
            </AreaChart>
          </ChartContainer>
        ) : (
          <EmptyState compact>{emptyLabel}</EmptyState>
        )}
      </CardContent>
    </Card>
  );
}
