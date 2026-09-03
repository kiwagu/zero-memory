'use client';

import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from 'recharts';

import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@workspace/ui/components/card';
import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from '@workspace/ui/components/chart';
import { EmptyState } from '@workspace/ui/components/common/empty-state';

/** One day of the activity series (matches the dashboard_metrics_series RPC). */
export type ActivityPoint = {
  date: string;
  recall_calls: number;
  captured: number;
};

/**
 * ActivityChart — the value dashboard's focal time-series: a stacked area of
 * recall/build_context calls and agent-captured memories per day. Presentational
 * (a client component, since Recharts renders in the browser): all strings and
 * the locale come from the caller so i18n stays in the app. Colors are the
 * design-system chart tokens, so light/dark themes are automatic.
 */
export function ActivityChart({
  title,
  data,
  locale,
  labels,
  emptyLabel,
  ...props
}: React.ComponentPropsWithoutRef<typeof Card> & {
  title: string;
  data: ActivityPoint[];
  locale: string;
  labels: { recalls: string; captured: string };
  emptyLabel: string;
}) {
  const config = {
    // recall_calls takes the darker token for prominence, captured the lighter.
    recall_calls: { label: labels.recalls, color: 'var(--chart-2)' },
    captured: { label: labels.captured, color: 'var(--chart-1)' },
  } satisfies ChartConfig;

  const dateFormat = new Intl.DateTimeFormat(locale, {
    month: 'short',
    day: 'numeric',
  });
  const formatDay = (value: string): string =>
    dateFormat.format(new Date(`${value}T00:00:00`));

  const hasActivity = data.some(
    (point) => point.recall_calls > 0 || point.captured > 0
  );

  return (
    <Card {...props}>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardContent>
        {hasActivity ? (
          <ChartContainer
            config={config}
            className="aspect-auto h-[240px] w-full"
          >
            <AreaChart data={data} margin={{ left: 12, right: 12 }}>
              <defs>
                <linearGradient id="fillRecalls" x1="0" y1="0" x2="0" y2="1">
                  <stop
                    offset="5%"
                    stopColor="var(--color-recall_calls)"
                    stopOpacity={0.8}
                  />
                  <stop
                    offset="95%"
                    stopColor="var(--color-recall_calls)"
                    stopOpacity={0.1}
                  />
                </linearGradient>
                <linearGradient id="fillCaptured" x1="0" y1="0" x2="0" y2="1">
                  <stop
                    offset="5%"
                    stopColor="var(--color-captured)"
                    stopOpacity={0.8}
                  />
                  <stop
                    offset="95%"
                    stopColor="var(--color-captured)"
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
                dataKey="captured"
                type="natural"
                fill="url(#fillCaptured)"
                stroke="var(--color-captured)"
                stackId="activity"
              />
              <Area
                dataKey="recall_calls"
                type="natural"
                fill="url(#fillRecalls)"
                stroke="var(--color-recall_calls)"
                stackId="activity"
              />
              <ChartLegend content={<ChartLegendContent />} />
            </AreaChart>
          </ChartContainer>
        ) : (
          <EmptyState compact>{emptyLabel}</EmptyState>
        )}
      </CardContent>
    </Card>
  );
}
