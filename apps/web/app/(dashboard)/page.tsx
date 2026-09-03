import Link from 'next/link';

import { Alert, AlertDescription } from '@workspace/ui/components/alert';
import { EmptyState } from '@workspace/ui/components/common/empty-state';
import { ActivityChart } from '@workspace/ui/components/dashboard/activity-chart';
import { ComparisonChart } from '@workspace/ui/components/dashboard/comparison-chart';
import { InventoryStrip } from '@workspace/ui/components/dashboard/inventory-strip';
import { MetricGrid } from '@workspace/ui/components/dashboard/metric-grid';
import { MetricStat } from '@workspace/ui/components/dashboard/metric-stat';
import { TokensSavedCard } from '@workspace/ui/components/dashboard/tokens-saved-card';
import {
  TopFactsList,
  type TopFactItem,
} from '@workspace/ui/components/dashboard/top-facts-list';
import { cn } from '@workspace/ui/lib/utils';

import { getRequestMessages } from '@/lib/i18n';
import {
  computeWeeklyDigest,
  dashboardMetricsSchema,
  estimateMinutesSaved,
  metricsSeriesSchema,
  MINUTES_PER_BRIEFING,
  reconstructionUsdPerMtok,
  roiResultSchema,
  USEFULNESS_PHASE_MIN_EVENTS,
  WEEKLY_DIGEST_DAYS,
  type AgeBucket,
} from '@/lib/insights';
import { kindLabel } from '@/lib/memory';
import { budgetStatusViaServer } from '@/lib/mcp';
import { createServerSupabaseClient } from '@/lib/supabase/server';

type SearchParams = Promise<{ days?: string }>;

const PERIODS = [7, 30, 90] as const;
type Period = (typeof PERIODS)[number];

// Categorical series colours for the combined tokens-saved chart. Blue (read) /
// red (write) — a deliberate hue pair to compare the two correlated series;
// both read on light and dark backgrounds.
const TOKENS_READ_COLOR = '#3b82f6';
const TOKENS_WRITE_COLOR = '#ef4444';

function resolvePeriod(raw: string | undefined): Period {
  const value = Number.parseInt(raw ?? '', 10);
  return (PERIODS as readonly number[]).includes(value)
    ? (value as Period)
    : 30;
}

/** hits/total → integer percent string, or null when there is no data. */
function percent(num: number, den: number): number | null {
  return den > 0 ? Math.round((num / den) * 100) : null;
}

/** Below this briefing hit-rate (%) the page shows a coverage warning. */
const BRIEFING_WARN_BELOW = 50;

/** ISO timestamp → localized relative phrase ("3 minutes ago"). */
function relativeTime(iso: string, locale: string): string {
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  const minutes = Math.round((new Date(iso).getTime() - Date.now()) / 60_000);
  if (Math.abs(minutes) < 60) return rtf.format(minutes, 'minute');
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return rtf.format(hours, 'hour');
  return rtf.format(Math.round(hours / 24), 'day');
}

export default async function InsightsPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const { days } = await searchParams;
  const period = resolvePeriod(days);
  const { locale, t } = await getRequestMessages();
  const nf = new Intl.NumberFormat(locale);
  const df = new Intl.DateTimeFormat(locale, {
    day: 'numeric',
    month: 'short',
  });

  // Period label + link per option, with literal t() keys (no key indirection).
  const periodOptions = [
    { value: 7, label: t('insights.period.7d'), href: '/?days=7' },
    { value: 30, label: t('insights.period.30d'), href: '/' },
    { value: 90, label: t('insights.period.90d'), href: '/?days=90' },
  ] as const;

  const supabase = await createServerSupabaseClient();
  // The DB computes the window from its own clock (p_days), avoiding a client
  // Date.now() in render and any client/server skew.
  const { data, error } = await supabase.rpc('dashboard_metrics', {
    p_days: period,
  });

  const parsed = data ? dashboardMetricsSchema.safeParse(data) : null;
  const metrics = parsed?.success ? parsed.data : null;

  // Daily activity series for the focal chart (best-effort: a failed/invalid
  // series just hides the chart, it never fails the page).
  const { data: seriesData } = await supabase.rpc('dashboard_metrics_series', {
    p_days: period,
  });
  const seriesParsed = seriesData
    ? metricsSeriesSchema.safeParse(seriesData)
    : null;
  const series = seriesParsed?.success ? seriesParsed.data : [];

  // Budget status, when a ceiling is in force at all. Best-effort and quiet:
  // this is a value dashboard, and it must not fail — or grow an apologetic
  // empty state — because a budget could not be read. Absent means there is
  // nothing to show, which is what an unconfigured deployment always sees.
  const {
    data: { session },
  } = await supabase.auth.getSession();
  const budget = session?.access_token
    ? await budgetStatusViaServer(session.access_token).catch(
        (error: unknown) => {
          // Swallowing the reason would make an absent tile indistinguishable
          // from a broken lookup — the tile is meant to be missing when there
          // is no ceiling, not when something failed quietly.
          console.warn(
            '[insights] budget status unavailable:',
            error instanceof Error ? error.message : String(error)
          );
          return null;
        }
      )
    : null;

  // Counterfactual benchmark runs (best-effort: no runs → invite placeholder).
  const { data: roiData } = await supabase.rpc('dashboard_roi');
  const roiParsed = roiData ? roiResultSchema.safeParse(roiData) : null;
  const roiRuns = roiParsed?.success ? roiParsed.data.runs : [];
  const latestRoi = roiRuns.at(-1) ?? null;
  const roiRate =
    latestRoi && latestRoi.probes > 0
      ? Math.round((latestRoi.exclusive_num / latestRoi.probes) * 100)
      : null;
  const roiTrend = roiRuns.map((run) =>
    run.probes > 0 ? Math.round((run.exclusive_num / run.probes) * 100) : 0
  );

  // Weekly digest ("this week vs last"): a fixed two-week series, independent
  // of the page's period selector — the comparison is always 7 vs 7. Best-effort
  // and quiet: no data / <2 weeks of history simply hides the section.
  const { data: digestSeriesData } = await supabase.rpc(
    'dashboard_metrics_series',
    { p_days: WEEKLY_DIGEST_DAYS }
  );
  const digestSeriesParsed = digestSeriesData
    ? metricsSeriesSchema.safeParse(digestSeriesData)
    : null;
  const weeklyDigest = digestSeriesParsed?.success
    ? computeWeeklyDigest(digestSeriesParsed.data)
    : null;

  // Reflection clusters awaiting the owner's review — a "what's new to look at"
  // nudge in the digest, not a delta. Best-effort head-count, quiet on failure.
  const { count: reflectionPendingRaw } = await supabase
    .from('reflection_candidates')
    .select('id', { count: 'exact', head: true })
    .eq('status', 'pending')
    .not('distilled_content', 'is', null);
  const reflectionPending = reflectionPendingRaw ?? 0;

  // Lifetime totals (all-time): the same RPC over an effectively unbounded
  // window. One extra read, no migration — big honest numbers for the strip.
  const { data: lifetimeData } = await supabase.rpc('dashboard_metrics', {
    p_days: 100_000,
  });
  const lifetimeParsed = lifetimeData
    ? dashboardMetricsSchema.safeParse(lifetimeData)
    : null;
  const lifetime = lifetimeParsed?.success ? lifetimeParsed.data : null;

  const isEmpty =
    metrics !== null &&
    metrics.recall_calls === 0 &&
    metrics.briefing_total === 0 &&
    metrics.captured_while_working === 0 &&
    metrics.live_share_den === 0 &&
    metrics.top_facts.length === 0;

  const hitRate = metrics
    ? percent(metrics.briefing_hits, metrics.briefing_total)
    : null;
  const liveRate = metrics
    ? percent(metrics.live_share_num, metrics.live_share_den)
    : null;
  const reinforcedRate = metrics
    ? percent(metrics.reinforced_num, metrics.reinforced_den)
    : null;
  const usefulnessRate = metrics
    ? percent(metrics.usefulness_num, metrics.usefulness_den)
    : null;
  const emptyRecallRate = metrics
    ? percent(metrics.empty_recall_num, metrics.empty_recall_den)
    : null;
  // null = no judged facts at all (usually: no watcher connected) → the tile
  // shows the connect placeholder, never a misleading 0%.
  const precisionRate = metrics
    ? percent(metrics.precision_num, metrics.precision_den)
    : null;
  // Quality tile phase: proxy until the usefulness signal has real coverage.
  const usefulnessReady =
    (metrics?.recall_used_events ?? 0) >= USEFULNESS_PHASE_MIN_EVENTS;
  const staleMedianDays =
    metrics?.stale_median_days === null || metrics === null
      ? null
      : Math.round(metrics.stale_median_days);

  // Corpus-age vitrine: how the live corpus ages under ranking-time decay.
  const fadedRate = metrics
    ? percent(metrics.faded_num, metrics.faded_den)
    : null;
  const corpusAgeDays =
    metrics === null || metrics.corpus_median_age_days === null
      ? null
      : Math.round(metrics.corpus_median_age_days);
  // Literal t() keys per bucket (no key indirection).
  const ageBucketLabels: Record<AgeBucket['key'], string> = {
    d7: t('insights.age.d7'),
    d30: t('insights.age.d30'),
    d90: t('insights.age.d90'),
    d365: t('insights.age.d365'),
    older: t('insights.age.older'),
  };

  // Time saved (windowed, conservative estimate): re-orientation avoided per
  // briefing + re-finding avoided per recall. Hours for the tile, $ at a
  // blended hourly rate for the hint.
  const minutesSaved = metrics
    ? estimateMinutesSaved(metrics.briefing_hits)
    : 0;
  const hoursSaved = minutesSaved / 60;

  const topFacts: TopFactItem[] = (metrics?.top_facts ?? [])
    // Defence in depth: the RPC already returns owned facts only, but never
    // render one without content — a foreign fact must not leak, even as an id.
    .filter(
      (fact): fact is typeof fact & { content: string } => fact.content !== null
    )
    .map((fact) => ({
      id: fact.id,
      primary: fact.content,
      meta: fact.kind ? kindLabel(fact.kind, t) : undefined,
      count: t('insights.topFacts.count', { count: nf.format(fact.surfaced) }),
      href: `/memory/${fact.id}`,
    }));

  // Hero "compounding context": facts ZM retained as you worked, accumulated
  // across the window (a memoryless baseline would be a flat zero, so it is not
  // plotted — the rising curve is the point).
  const comparison = series.map((point, index) => ({
    date: point.date,
    // Cumulative captures up to this day (pure — no render-time mutation).
    value: series
      .slice(0, index + 1)
      .reduce((sum, earlier) => sum + earlier.captured, 0),
  }));

  // Per-metric daily trends for the tile sparklines.
  const capturedTrend = series.map((point) => point.captured);

  // Reconstruction $ for a token pool, and the summed read+write total.
  const rebuildUsd = (tokens: number): string =>
    new Intl.NumberFormat(locale, {
      style: 'currency',
      currency: 'USD',
    }).format((tokens / 1_000_000) * reconstructionUsdPerMtok());
  const reconstructionRate = `$${reconstructionUsdPerMtok()}`;
  // Quality trends from the judge series; flat zeros without a watcher.
  const usedTrend = series.map((point) => point.used);
  const precisionTrend = series.map((point) =>
    point.judged > 0 ? Math.round((point.relevant / point.judged) * 100) : 0
  );
  const hasQualitySignal = series.some((point) => point.judged > 0);

  // Weekly-digest tiles: current-week value + a signed "vs last week" delta.
  // Signs are localized; a zero delta reads as "no change", not "+0".
  const nfSigned = new Intl.NumberFormat(locale, { signDisplay: 'exceptZero' });
  const countDelta = (delta: number): string =>
    delta === 0
      ? t('insights.digest.noChange')
      : t('insights.digest.delta', { delta: nfSigned.format(delta) });
  const rateDelta = (delta: number): string =>
    delta === 0
      ? t('insights.digest.noChange')
      : t('insights.digest.deltaRate', { delta: nfSigned.format(delta) });
  const digestItems = weeklyDigest
    ? [
        {
          key: 'captured',
          label: t('insights.digest.captured'),
          value: nf.format(weeklyDigest.captured.current),
          delta: countDelta(weeklyDigest.captured.delta),
        },
        {
          key: 'fired',
          label: t('insights.digest.fired'),
          value: nf.format(weeklyDigest.fired.current),
          delta: countDelta(weeklyDigest.fired.delta),
        },
        {
          key: 'tokens',
          label: t('insights.digest.tokens'),
          value: nf.format(weeklyDigest.tokens.current),
          delta: countDelta(weeklyDigest.tokens.delta),
        },
        // Hit-rate only when this week has briefings to judge; delta only when
        // the prior week did too.
        ...(weeklyDigest.hitRate.current !== null
          ? [
              {
                key: 'hitRate',
                label: t('insights.digest.hitRate'),
                value: `${weeklyDigest.hitRate.current}%`,
                delta:
                  weeklyDigest.hitRate.delta !== null
                    ? rateDelta(weeklyDigest.hitRate.delta)
                    : undefined,
              },
            ]
          : []),
      ]
    : [];

  return (
    <div className="mx-auto max-w-4xl space-y-6" data-testid="insights-page">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="space-y-1">
          <h1 className="text-xl font-semibold">{t('insights.title')}</h1>
          <p className="text-muted-foreground text-sm">
            {t('insights.description')}
          </p>
        </div>
        <nav className="flex gap-1" aria-label={t('insights.title')}>
          {periodOptions.map((option) => (
            <Link
              key={option.value}
              href={option.href}
              className={cn(
                'rounded-md px-3 py-1.5 text-sm',
                option.value === period
                  ? 'bg-secondary text-secondary-foreground font-medium'
                  : 'text-muted-foreground hover:bg-secondary/50'
              )}
            >
              {option.label}
            </Link>
          ))}
        </nav>
      </div>

      {error ? (
        <Alert variant="destructive">
          <AlertDescription>
            {t('insights.loadError', { message: error.message })}
          </AlertDescription>
        </Alert>
      ) : null}

      {metrics && isEmpty ? (
        <EmptyState
          className="rounded-xl border border-dashed"
          data-testid="insights-empty"
        >
          {t('insights.empty')}
        </EmptyState>
      ) : null}

      {metrics && !isEmpty ? (
        <>
          <ComparisonChart
            data-testid="insights-comparison-chart"
            title={t('insights.comparison.title')}
            description={t('insights.comparison.description')}
            data={comparison}
            locale={locale}
            emptyLabel={t('insights.comparison.empty')}
          />

          <InventoryStrip
            data-testid="insights-inventory"
            items={[
              {
                key: 'memories',
                label: t('insights.inventory.memories'),
                value: nf.format(metrics.live_share_den),
                delta:
                  metrics.memories_24h > 0
                    ? t('insights.inventory.delta', {
                        count: nf.format(metrics.memories_24h),
                      })
                    : undefined,
              },
              {
                key: 'entities',
                label: t('insights.inventory.entities'),
                value: nf.format(metrics.entities_total),
                delta:
                  metrics.entities_24h > 0
                    ? t('insights.inventory.delta', {
                        count: nf.format(metrics.entities_24h),
                      })
                    : undefined,
              },
              {
                key: 'scopes',
                label: t('insights.inventory.scopes'),
                value: nf.format(metrics.scope_coverage),
              },
              // All-time recall count folded in here instead of a separate
              // strip. Injected tokens are omitted — the chart already shows them.
              ...(lifetime
                ? [
                    {
                      key: 'recalls',
                      label: t('insights.inventory.recalls'),
                      value: nf.format(lifetime.recall_calls),
                    },
                  ]
                : []),
            ]}
            freshness={
              metrics.last_captured_at
                ? t('insights.inventory.lastCapture', {
                    when: relativeTime(metrics.last_captured_at, locale),
                  })
                : undefined
            }
          />

          {digestItems.length > 0 ? (
            <section className="space-y-2" data-testid="insights-digest">
              <h2 className="text-muted-foreground text-sm font-medium">
                {t('insights.digest.title')}
              </h2>
              <InventoryStrip
                items={digestItems}
                freshness={
                  reflectionPending > 0
                    ? t('insights.digest.reflections', {
                        count: nf.format(reflectionPending),
                      })
                    : undefined
                }
              />
            </section>
          ) : null}

          {hitRate !== null && hitRate < BRIEFING_WARN_BELOW ? (
            <Alert data-testid="insights-briefing-warning">
              <AlertDescription>
                {t('insights.briefingWarning', {
                  hits: nf.format(metrics.briefing_hits),
                  total: nf.format(metrics.briefing_total),
                })}
              </AlertDescription>
            </Alert>
          ) : null}

          <section className="space-y-2">
            <h2 className="text-muted-foreground text-sm font-medium">
              {t('insights.section.value')}
            </h2>
            <MetricGrid maxPerRow={3}>
              {/* Headline: the outcome metric — answers only memory could give. */}
              <MetricStat
                data-testid="insights-metric-roi"
                label={t('insights.metric.roi')}
                value={roiRate === null ? '—' : `${roiRate}%`}
                hint={
                  latestRoi === null
                    ? // No benchmark yet — invite, never a 0% (same grace
                      // pattern as the watcher-gated precision tile).
                      t('insights.metric.roiRun')
                    : t('insights.metric.roiHint', {
                        num: nf.format(latestRoi.exclusive_num),
                        den: nf.format(latestRoi.probes),
                      })
                }
                trend={roiRuns.length > 1 ? roiTrend : undefined}
              />
              <MetricStat
                data-testid="insights-metric-timeSaved"
                label={t('insights.metric.timeSaved')}
                value={
                  hoursSaved > 0
                    ? t('insights.metric.timeSavedValue', {
                        hours: new Intl.NumberFormat(locale, {
                          maximumFractionDigits: 1,
                        }).format(hoursSaved),
                      })
                    : '—'
                }
                hint={t('insights.metric.timeSavedHint', {
                  min: MINUTES_PER_BRIEFING,
                })}
              />
              <MetricStat
                data-testid="insights-metric-capturedWhileWorking"
                label={t('insights.metric.capturedWhileWorking')}
                value={nf.format(metrics.captured_while_working)}
                hint={t('insights.metric.capturedWhileWorkingHint')}
                trend={capturedTrend}
              />
              {/* Only when a ceiling actually applies. With none in force
                  there is nothing to report, and a tile saying "unlimited"
                  would advertise a constraint this deployment does not have. */}
              {budget ? (
                <MetricStat
                  data-testid="insights-metric-budget"
                  label={t('insights.budget.label')}
                  value={`${nf.format(budget.used)} / ${nf.format(budget.limit)}`}
                  progress={{
                    value: budget.used,
                    max: budget.limit,
                    label: t('insights.budget.label'),
                  }}
                  hint={
                    // The monthly window is anchored at this account's start
                    // of use and genuinely turns over — the date is when the
                    // counter starts from zero again. A server that cannot
                    // anchor reports no date; its window trails and never
                    // resets, so no reset date is claimed.
                    budget.window_ends_at
                      ? t('insights.budget.hint', {
                          date: df.format(new Date(budget.window_ends_at)),
                        })
                      : t('insights.budget.hintTrailing', {
                          days: nf.format(budget.window_days),
                        })
                  }
                />
              ) : null}
            </MetricGrid>

            {/* Combined read + write savings — one widget, two coloured
                sparklines, summed "total to rebuild" in the header. */}
            <TokensSavedCard
              data-testid="insights-tokens-saved"
              title={t('insights.tokensSaved.title')}
              help={t('insights.tokensSaved.help', {
                rate: reconstructionRate,
              })}
              locale={locale}
              emptyLabel={t('insights.tokensSaved.empty')}
              total={
                metrics.saved_tokens + metrics.write_tokens_saved > 0
                  ? t('insights.tokensSaved.total', {
                      usd: rebuildUsd(
                        metrics.saved_tokens + metrics.write_tokens_saved
                      ),
                      rate: reconstructionRate,
                    })
                  : undefined
              }
              read={{
                label: t('insights.tokensSaved.injected'),
                value: nf.format(metrics.saved_tokens),
                usd:
                  metrics.saved_tokens > 0
                    ? rebuildUsd(metrics.saved_tokens)
                    : undefined,
                color: TOKENS_READ_COLOR,
              }}
              write={{
                label: t('insights.tokensSaved.captured'),
                value: nf.format(metrics.write_tokens_saved),
                usd:
                  metrics.write_tokens_saved > 0
                    ? rebuildUsd(metrics.write_tokens_saved)
                    : undefined,
                color: TOKENS_WRITE_COLOR,
              }}
              data={series.map((point) => ({
                date: point.date,
                read: point.saved_tokens,
                write: point.write_tokens,
              }))}
            />
          </section>

          <section className="space-y-2">
            <h2 className="text-muted-foreground text-sm font-medium">
              {t('insights.section.quality')}
            </h2>
            <MetricGrid maxPerRow={3}>
              {usefulnessReady ? (
                <MetricStat
                  data-testid="insights-metric-usefulness"
                  label={t('insights.metric.usefulness')}
                  value={usefulnessRate === null ? '—' : `${usefulnessRate}%`}
                  hint={
                    usefulnessRate === null
                      ? t('insights.metric.usefulnessNoData')
                      : t('insights.metric.usefulnessHint', {
                          num: nf.format(metrics.usefulness_num),
                          den: nf.format(metrics.usefulness_den),
                        })
                  }
                  trend={usedTrend}
                />
              ) : (
                <MetricStat
                  data-testid="insights-metric-reinforced"
                  label={t('insights.metric.reinforced')}
                  value={reinforcedRate === null ? '—' : `${reinforcedRate}%`}
                  hint={
                    reinforcedRate === null
                      ? t('insights.metric.reinforcedNoData')
                      : t('insights.metric.reinforcedHint', {
                          num: nf.format(metrics.reinforced_num),
                          den: nf.format(metrics.reinforced_den),
                        })
                  }
                />
              )}
              <MetricStat
                data-testid="insights-metric-staleness"
                label={t('insights.metric.staleness')}
                value={
                  staleMedianDays === null
                    ? '—'
                    : t('insights.metric.stalenessValue', {
                        days: nf.format(staleMedianDays),
                      })
                }
                hint={
                  staleMedianDays === null
                    ? t('insights.metric.stalenessNoData')
                    : t('insights.metric.stalenessHint', {
                        num: nf.format(metrics.stale_over_90_num),
                        den: nf.format(metrics.reinforced_den),
                      })
                }
              />
              <MetricStat
                data-testid="insights-metric-precision"
                label={t('insights.metric.precision')}
                value={precisionRate === null ? '—' : `${precisionRate}%`}
                hint={
                  precisionRate === null
                    ? // Judged by an optional, client-specific watcher; absent
                      // one, invite — a 0% here would read as bad precision.
                      t('insights.metric.precisionConnect')
                    : t('insights.metric.precisionHint', {
                        num: nf.format(metrics.precision_num),
                        den: nf.format(metrics.precision_den),
                      })
                }
                // No sparkline under the connect placeholder — a flat zero
                // line would read as measured-and-bad.
                trend={hasQualitySignal ? precisionTrend : undefined}
              />
            </MetricGrid>
          </section>

          <section className="space-y-2">
            <h2 className="text-muted-foreground text-sm font-medium">
              {t('insights.section.health')}
            </h2>
            <MetricGrid maxPerRow={2}>
              <MetricStat
                data-testid="insights-metric-liveShare"
                label={t('insights.metric.liveShare')}
                value={liveRate === null ? '—' : `${liveRate}%`}
                hint={t('insights.metric.liveShareHint', {
                  num: nf.format(metrics.live_share_num),
                  den: nf.format(metrics.live_share_den),
                })}
              />
              {/* KPI → evidence: the tile opens the feed filtered to the
                  empty recalls it counts, so the number is inspectable. */}
              <Link href="/activity?f=empty" className="block">
                <MetricStat
                  data-testid="insights-metric-emptyRecalls"
                  className="hover:bg-secondary/30 h-full transition-colors"
                  label={t('insights.metric.emptyRecalls')}
                  value={emptyRecallRate === null ? '—' : `${emptyRecallRate}%`}
                  hint={
                    emptyRecallRate === null
                      ? t('insights.metric.emptyRecallsNoData')
                      : t('insights.metric.emptyRecallsHint', {
                          num: nf.format(metrics.empty_recall_num),
                          den: nf.format(metrics.empty_recall_den),
                        })
                  }
                />
              </Link>
            </MetricGrid>
          </section>

          <section className="space-y-2">
            <h2 className="text-muted-foreground text-sm font-medium">
              {t('insights.section.age')}
            </h2>
            <MetricGrid maxPerRow={2}>
              <MetricStat
                data-testid="insights-metric-faded"
                label={t('insights.metric.faded')}
                value={fadedRate === null ? '—' : `${fadedRate}%`}
                hint={
                  fadedRate === null
                    ? t('insights.metric.fadedNoData')
                    : t('insights.metric.fadedHint', {
                        num: nf.format(metrics.faded_num),
                        den: nf.format(metrics.faded_den),
                      })
                }
              />
              <MetricStat
                data-testid="insights-metric-corpusAge"
                label={t('insights.metric.corpusAge')}
                value={
                  corpusAgeDays === null
                    ? '—'
                    : t('insights.metric.corpusAgeValue', {
                        days: nf.format(corpusAgeDays),
                      })
                }
                hint={t('insights.metric.corpusAgeHint')}
              />
            </MetricGrid>
            {/* Age distribution of the live corpus — inventory-quiet, the
                buckets are context for the two KPIs above. */}
            <InventoryStrip
              data-testid="insights-age-buckets"
              items={metrics.age_buckets.map((bucket) => ({
                key: bucket.key,
                label: ageBucketLabels[bucket.key],
                value: nf.format(bucket.count),
              }))}
            />
          </section>

          <ActivityChart
            data-testid="insights-activity-chart"
            title={t('insights.chart.titleWithRecalls', {
              count: nf.format(metrics.recall_calls),
            })}
            data={series}
            locale={locale}
            labels={{
              recalls: t('insights.chart.recalls'),
              captured: t('insights.chart.captured'),
            }}
            emptyLabel={t('insights.chart.empty')}
          />

          <TopFactsList
            data-testid="insights-top-facts"
            title={t('insights.topFacts.title')}
            items={topFacts}
            emptyLabel={t('insights.topFacts.empty')}
            linkComponent={Link}
          />
        </>
      ) : null}
    </div>
  );
}
