import { z } from 'zod';

/**
 * Result shape of the `dashboard_metrics` RPC. Web-only: nothing
 * server-side parses this, so the schema lives with its single consumer rather
 * than in @workspace/contracts (which the Next bundler cannot import — its
 * NodeNext `.js` internal imports don't resolve under Turbopack). Counts and
 * numerator/denominator pairs only; the page derives rates so a zero
 * denominator renders "no data", not NaN.
 */

/** One surfaced-count row of "top facts". Not-owned (shared) memories arrive
 * with id only — the RPC hides other users' content, mirroring RLS. */
export const topFactSchema = z.object({
  id: z.string(),
  surfaced: z.number().int().nonnegative(),
  content: z.string().nullable(),
  kind: z.string().nullable(),
});
export type TopFact = z.infer<typeof topFactSchema>;

/** One age bucket of the live corpus (corpus-age vitrine). Keys are the
 * bucket upper bounds: d7 / d30 / d90 / d365 / older. */
export const ageBucketSchema = z.object({
  key: z.enum(['d7', 'd30', 'd90', 'd365', 'older']),
  count: z.number().int().nonnegative(),
});
export type AgeBucket = z.infer<typeof ageBucketSchema>;

export const dashboardMetricsSchema = z.object({
  recall_calls: z.number().int().nonnegative(),
  briefing_hits: z.number().int().nonnegative(),
  briefing_total: z.number().int().nonnegative(),
  saved_tokens: z.number().nonnegative(),
  /** Write side: char/4 token estimate of agent-captured memory content —
   * the tokens you didn't type. Summed with saved_tokens (read) by the user. */
  write_tokens_saved: z.number().nonnegative(),
  captured_while_working: z.number().int().nonnegative(),
  live_share_num: z.number().int().nonnegative(),
  live_share_den: z.number().int().nonnegative(),
  scope_coverage: z.number().int().nonnegative(),
  /** Surfaced facts that kept coming back (>= 2 recalls) — usefulness proxy. */
  reinforced_num: z.number().int().nonnegative(),
  /** Distinct owned facts surfaced in the window (reinforced denominator). */
  reinforced_den: z.number().int().nonnegative(),
  /** Surfaced facts actually used (recall_used) — true usefulness hit-rate
   * numerator. Sparse until the out-of-band watcher judge lands. */
  usefulness_num: z.number().int().nonnegative(),
  /** Distinct owned facts surfaced in the window (usefulness denominator). */
  usefulness_den: z.number().int().nonnegative(),
  /** All-time owned entities (inventory strip). */
  entities_total: z.number().int().nonnegative(),
  /** Owned memories / entities created in the last 24h (growth deltas). */
  memories_24h: z.number().int().nonnegative(),
  entities_24h: z.number().int().nonnegative(),
  /** Newest owned capture — the inventory freshness stamp. */
  last_captured_at: z.string().nullable(),
  /** Result-attributed recalls that surfaced nothing / all of them. */
  empty_recall_num: z.number().int().nonnegative(),
  empty_recall_den: z.number().int().nonnegative(),
  /** Median age (days) of distinct surfaced owned facts; null when none. */
  stale_median_days: z.number().nonnegative().nullable(),
  /** Surfaced facts older than 90 days (cutoff echoed in the UI hint). */
  stale_over_90_num: z.number().int().nonnegative(),
  /** recall_used events in the window — usefulness-signal coverage. */
  recall_used_events: z.number().int().nonnegative(),
  /** Context precision over JUDGED facts: relevant / judged. Both zero when
   * no watcher judge is connected — the UI shows a connect placeholder. */
  precision_num: z.number().int().nonnegative(),
  precision_den: z.number().int().nonnegative(),
  top_facts: z.array(topFactSchema),
  /** Median age (days) of the LIVE corpus (the ranking population); null when
   * the corpus is empty. Whole-corpus, not windowed — like the inventory. */
  corpus_median_age_days: z.number().nonnegative().nullable(),
  /** Live memories older than their kind's ranking half-life — decay ranks
   * them at less than half strength — / all live memories. */
  faded_num: z.number().int().nonnegative(),
  faded_den: z.number().int().nonnegative(),
  /** Live-corpus age distribution; all five buckets always present. */
  age_buckets: z.array(ageBucketSchema),
  since: z.string(),
});
export type DashboardMetrics = z.infer<typeof dashboardMetricsSchema>;

/**
 * Quality-tile phase switch: below this many recall_used events in the window
 * the usefulness hit-rate has no coverage yet, so the tile shows the
 * reinforced proxy instead. Both never render together (ADR'd composition).
 * v1 constant — tune when the judge's real coverage curve is known.
 */
export const USEFULNESS_PHASE_MIN_EVENTS = 25;

/**
 * USD per 1M tokens for the "≈ $ to rebuild" figure. Priced at a mid-tier
 * model's OUTPUT rate, not input: without a memory the model would have to
 * REGENERATE this context (output tokens), so output pricing is the honest
 * reconstruction cost — feeding the tokens (input) happens either way and is
 * not what a memory saves. Single resolver so a per-user price (personal
 * settings, once they exist) replaces the constant without touching consumers.
 */
const RECONSTRUCTION_USD_PER_MTOK = 15;
export function reconstructionUsdPerMtok(): number {
  return RECONSTRUCTION_USD_PER_MTOK;
}

/**
 * Time-saved estimate (minutes): the re-orientation a memory removes at session
 * start — each briefing that carried context. ONE conservative assumption
 * (minutes per briefing), stated in the UI and never presented as measured. No
 * money conversion: the dollar aggregate is ROI, not a stacked hourly guess.
 */
export const MINUTES_PER_BRIEFING = 3;
export function estimateMinutesSaved(briefingHits: number): number {
  return briefingHits * MINUTES_PER_BRIEFING;
}

/** One surfaced-fact preview on a feed row: owned facts carry kind + a
 * truncated preview; a foreign (shared-scope) fact stays id-only. */
export const activityFactSchema = z.object({
  id: z.string(),
  kind: z.string().nullable(),
  content: z.string().nullable(),
});
export type ActivityFact = z.infer<typeof activityFactSchema>;

/** One row of the `dashboard_activity` feed. Fact previews are resolved at
 * read time from the surfaced ids. */
export const activityEventSchema = z.object({
  id: z.string(),
  occurred_at: z.string(),
  tool: z.string(),
  agent_name: z.string().nullable(),
  /** req_ correlation id; null on rows recorded outside a request context. */
  request_id: z.string().nullable(),
  /** The search string the client sent; null on rows predating its emit. */
  query: z.string().nullable(),
  /** Facts surfaced by this call; null on rows predating result metering. */
  returned: z.number().int().nonnegative().nullable(),
  /** The call failed — its row carries no surfaced ids at all. */
  error: z.boolean(),
  /** Up to 50 surfaced-fact previews (the UI portions them). */
  facts: z.array(activityFactSchema),
});
export type ActivityEvent = z.infer<typeof activityEventSchema>;

export const activityResultSchema = z.object({
  total: z.number().int().nonnegative(),
  events: z.array(activityEventSchema),
});
export type ActivityResult = z.infer<typeof activityResultSchema>;

/** One run of the counterfactual ROI benchmark from `dashboard_roi`. */
export const roiRunSchema = z.object({
  run_id: z.string(),
  run_at: z.string(),
  probes: z.number().int().nonnegative(),
  with_num: z.number().int().nonnegative(),
  without_num: z.number().int().nonnegative(),
  /** Answered WITH memory and NOT without — the headline counterfactual. */
  exclusive_num: z.number().int().nonnegative(),
});
export type RoiRun = z.infer<typeof roiRunSchema>;

export const roiResultSchema = z.object({
  /** Oldest first (chart-ready); empty until the first benchmark run. */
  runs: z.array(roiRunSchema),
});
export type RoiResult = z.infer<typeof roiResultSchema>;

/** One day of the activity series from `dashboard_metrics_series`. */
export const metricsPointSchema = z.object({
  date: z.string(),
  recall_calls: z.number().int().nonnegative(),
  captured: z.number().int().nonnegative(),
  saved_tokens: z.number().nonnegative(),
  /** Per-day write side: char/4 token estimate of that day's captures. */
  write_tokens: z.number().nonnegative(),
  briefing_hits: z.number().int().nonnegative(),
  briefing_total: z.number().int().nonnegative(),
  /** Per-day judge quality (distinct memories; zeros without a watcher). */
  judged: z.number().int().nonnegative(),
  relevant: z.number().int().nonnegative(),
  used: z.number().int().nonnegative(),
});
export type MetricsPoint = z.infer<typeof metricsPointSchema>;

export const metricsSeriesSchema = z.array(metricsPointSchema);
export type MetricsSeries = z.infer<typeof metricsSeriesSchema>;

/** Days the weekly-digest section compares: the last 7 vs the 7 before. */
export const WEEKLY_DIGEST_DAYS = 14;
const DIGEST_WEEK = 7;
const DIGEST_DAY_MS = 86_400_000;

/** One week-over-week figure: the current-week value and its change. Rates are
 * percent with a percentage-point delta; a null rate means "no data this week",
 * a null delta means "no comparable prior week". */
export type WeeklyDelta = {
  current: number;
  delta: number;
};

export type WeeklyDigest = {
  captured: WeeklyDelta;
  fired: WeeklyDelta;
  /** Read + write tokens saved. */
  tokens: WeeklyDelta;
  /** Briefing hit-rate (percent) and its percentage-point change; either side
   * null when that week had no briefings to judge. */
  hitRate: { current: number | null; delta: number | null };
};

/**
 * Split a daily series into the last 7 days vs the 7 before and diff the value
 * counters — the "this week vs last week" digest. Pure: the anchor is the
 * latest DATE in the series (no `Date.now()`, so no client/server skew), and
 * the split is by calendar date, robust to missing days. Returns null when the
 * series does not span two weeks or the whole window is silent — the section
 * then simply does not render (quiet degradation, like the rest of the page).
 */
export function computeWeeklyDigest(
  series: MetricsSeries
): WeeklyDigest | null {
  if (series.length === 0) return null;
  const sorted = [...series].sort((a, b) => a.date.localeCompare(b.date));

  const anchorMs = Date.parse(`${sorted[sorted.length - 1]!.date}T00:00:00Z`);
  const earliestMs = Date.parse(`${sorted[0]!.date}T00:00:00Z`);
  if (Number.isNaN(anchorMs) || Number.isNaN(earliestMs)) return null;

  const thisWeekStart = anchorMs - (DIGEST_WEEK - 1) * DIGEST_DAY_MS;
  const lastWeekStart = anchorMs - (2 * DIGEST_WEEK - 1) * DIGEST_DAY_MS;
  // With every day inside the last week there is no prior week to compare
  // against — a fresh corpus, so the section stays hidden rather than diffing
  // against an empty baseline.
  if (earliestMs >= thisWeekStart) return null;

  const thisWeek: MetricsPoint[] = [];
  const lastWeek: MetricsPoint[] = [];
  for (const point of sorted) {
    const ms = Date.parse(`${point.date}T00:00:00Z`);
    if (Number.isNaN(ms)) continue;
    if (ms >= thisWeekStart) thisWeek.push(point);
    else if (ms >= lastWeekStart) lastWeek.push(point);
  }

  const sum = (
    rows: MetricsPoint[],
    pick: (p: MetricsPoint) => number
  ): number => rows.reduce((acc, p) => acc + pick(p), 0);
  const rate = (num: number, den: number): number | null =>
    den > 0 ? Math.round((num / den) * 100) : null;

  const capturedNow = sum(thisWeek, (p) => p.captured);
  const capturedPrev = sum(lastWeek, (p) => p.captured);
  const firedNow = sum(thisWeek, (p) => p.used);
  const firedPrev = sum(lastWeek, (p) => p.used);
  const tokensNow = sum(thisWeek, (p) => p.saved_tokens + p.write_tokens);
  const tokensPrev = sum(lastWeek, (p) => p.saved_tokens + p.write_tokens);
  const hitNow = rate(
    sum(thisWeek, (p) => p.briefing_hits),
    sum(thisWeek, (p) => p.briefing_total)
  );
  const hitPrev = rate(
    sum(lastWeek, (p) => p.briefing_hits),
    sum(lastWeek, (p) => p.briefing_total)
  );

  // A window with zero activity on both sides has nothing to report.
  if (
    capturedNow +
      capturedPrev +
      firedNow +
      firedPrev +
      tokensNow +
      tokensPrev ===
      0 &&
    hitNow === null &&
    hitPrev === null
  ) {
    return null;
  }

  return {
    captured: { current: capturedNow, delta: capturedNow - capturedPrev },
    fired: { current: firedNow, delta: firedNow - firedPrev },
    tokens: { current: tokensNow, delta: tokensNow - tokensPrev },
    hitRate: {
      current: hitNow,
      delta: hitNow !== null && hitPrev !== null ? hitNow - hitPrev : null,
    },
  };
}
