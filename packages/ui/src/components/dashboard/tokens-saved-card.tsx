'use client';

import { Info } from 'lucide-react';
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
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@workspace/ui/components/tooltip';

/** One day of the read + write token series (shared axes). */
export type TokensSavedPoint = {
  date: string;
  read: number;
  write: number;
};

/** One side (read / write) of the combined widget. */
export type TokensSavedSide = {
  /** Muted caption, e.g. "read · context you didn't retype". */
  label: string;
  /** Formatted token count, e.g. "377,000". */
  value: string;
  /** Formatted "≈ $X to rebuild" line. */
  usd?: string;
  /** CSS color — used for the value, the legend dot, and the chart series. */
  color: string;
};

/**
 * TokensSavedCard — read + write savings in ONE widget: both series overlaid on
 * shared axes (they correlate, so comparing them on one chart is the point).
 * The header carries colour-coded totals ("377,000 / 244,513", read colour /
 * write colour) and a matching dot legend. Presentational client component
 * (Recharts renders in the browser); strings/colours come from the caller.
 */
export function TokensSavedCard({
  title,
  help,
  total,
  locale,
  read,
  write,
  data,
  emptyLabel,
  ...props
}: React.ComponentPropsWithoutRef<typeof Card> & {
  title: string;
  /** Explanation shown in a hover tooltip on the title's info icon. */
  help: string;
  /** Summed "≈ $X to rebuild" across both sides; optional. */
  total?: string;
  locale: string;
  read: TokensSavedSide;
  write: TokensSavedSide;
  data: TokensSavedPoint[];
  emptyLabel: string;
}) {
  const config = {
    read: { label: read.label, color: read.color },
    write: { label: write.label, color: write.color },
  } satisfies ChartConfig;

  const dateFormat = new Intl.DateTimeFormat(locale, {
    month: 'short',
    day: 'numeric',
  });
  const formatDay = (value: string): string =>
    dateFormat.format(new Date(`${value}T00:00:00`));

  const hasData = data.some((point) => point.read > 0 || point.write > 0);

  return (
    <Card {...props}>
      <CardHeader>
        <CardTitle className="flex items-center gap-1.5">
          {title}
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger
                aria-label={help}
                className="text-muted-foreground hover:text-foreground inline-flex focus-visible:outline-none"
              >
                <Info className="size-3.5" aria-hidden />
              </TooltipTrigger>
              <TooltipContent className="max-w-xs">{help}</TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </CardTitle>
        {/* Colour-coded totals double as the legend: read colour / write colour. */}
        <p className="text-2xl font-semibold tabular-nums">
          <span style={{ color: read.color }}>{read.value}</span>
          <span className="text-muted-foreground"> / </span>
          <span style={{ color: write.color }}>{write.value}</span>
        </p>
        <CardDescription className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="inline-flex items-center gap-1.5">
            <span
              aria-hidden
              className="size-2 rounded-full"
              style={{ backgroundColor: read.color }}
            />
            {read.label}
            {read.usd ? ` · ${read.usd}` : ''}
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span
              aria-hidden
              className="size-2 rounded-full"
              style={{ backgroundColor: write.color }}
            />
            {write.label}
            {write.usd ? ` · ${write.usd}` : ''}
          </span>
          {total ? <span>{total}</span> : null}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {hasData ? (
          <ChartContainer
            config={config}
            className="aspect-auto h-[220px] w-full"
          >
            <AreaChart data={data} margin={{ left: 12, right: 12 }}>
              <defs>
                <linearGradient id="fillRead" x1="0" y1="0" x2="0" y2="1">
                  <stop
                    offset="5%"
                    stopColor="var(--color-read)"
                    stopOpacity={0.25}
                  />
                  <stop
                    offset="95%"
                    stopColor="var(--color-read)"
                    stopOpacity={0.02}
                  />
                </linearGradient>
                <linearGradient id="fillWrite" x1="0" y1="0" x2="0" y2="1">
                  <stop
                    offset="5%"
                    stopColor="var(--color-write)"
                    stopOpacity={0.25}
                  />
                  <stop
                    offset="95%"
                    stopColor="var(--color-write)"
                    stopOpacity={0.02}
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
              {/* Overlaid (not stacked) on shared axes so the two correlate. */}
              <Area
                dataKey="read"
                type="monotone"
                fill="url(#fillRead)"
                stroke="var(--color-read)"
                strokeWidth={2}
              />
              <Area
                dataKey="write"
                type="monotone"
                fill="url(#fillWrite)"
                stroke="var(--color-write)"
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
