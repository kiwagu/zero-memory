import { z } from 'zod';

/**
 * The operator surface: the instance-wide aggregate an operator (or a tool
 * polling the instances it administers) reads through
 * `public.instance_metrics`. It sums the SAME value-metric definitions as the
 * personal dashboard across every user of the instance, plus operator-only
 * figures (seats, the hygiene queue, the latest eval runs).
 *
 * This schema is also the REGISTRY: an enumerable, reviewable statement of
 * exactly what leaves the instance about a user's data. The invariant it
 * carries is content-free — every field is a counter, score, distribution or
 * timestamp. There is deliberately no `top_facts` (memory content) and no
 * scope NAMES; `scope_coverage` is a count. The accompanying spec asserts the
 * registry holds no content-bearing key, so the guarantee is tested, not just
 * intended.
 */

const ageBucketSchema = z.object({
  key: z.enum(['d7', 'd30', 'd90', 'd365', 'older']),
  count: z.number().int().nonnegative(),
});

/** One eval-harness run as it surfaces on the operator side — scores only. */
const evalRunSummarySchema = z.object({
  run_at: z.string(),
  metrics: z.record(z.string(), z.unknown()),
  corpus_size: z.number().int().nonnegative(),
  engine_version: z.string().nullable(),
});

export const instanceMetricsSchema = z.object({
  // Seats — operator-only headcount for the instance.
  // users_active = anyone with activity in the window.
  users_total: z.number().int().nonnegative(),
  users_active: z.number().int().nonnegative(),
  // Operator-only operational health.
  hygiene_pending: z.number().int().nonnegative(),
  eval_runs: z.record(z.string(), evalRunSummarySchema),

  // The same value-metric definitions as the personal vitrine, summed across
  // all users (numerators and denominators kept separate so a rate is never
  // an average of per-user rates).
  recall_calls: z.number().int().nonnegative(),
  briefing_hits: z.number().int().nonnegative(),
  briefing_total: z.number().int().nonnegative(),
  saved_tokens: z.number().nonnegative(),
  write_tokens_saved: z.number().nonnegative(),
  captured_while_working: z.number().int().nonnegative(),
  live_share_num: z.number().int().nonnegative(),
  live_share_den: z.number().int().nonnegative(),
  scope_coverage: z.number().int().nonnegative(),
  reinforced_num: z.number().int().nonnegative(),
  reinforced_den: z.number().int().nonnegative(),
  usefulness_num: z.number().int().nonnegative(),
  usefulness_den: z.number().int().nonnegative(),
  entities_total: z.number().int().nonnegative(),
  memories_24h: z.number().int().nonnegative(),
  entities_24h: z.number().int().nonnegative(),
  last_captured_at: z.string().nullable(),
  empty_recall_num: z.number().int().nonnegative(),
  empty_recall_den: z.number().int().nonnegative(),
  stale_median_days: z.number().nonnegative().nullable(),
  stale_over_90_num: z.number().int().nonnegative(),
  recall_used_events: z.number().int().nonnegative(),
  precision_num: z.number().int().nonnegative(),
  precision_den: z.number().int().nonnegative(),
  corpus_median_age_days: z.number().nonnegative().nullable(),
  faded_num: z.number().int().nonnegative(),
  faded_den: z.number().int().nonnegative(),
  age_buckets: z.array(ageBucketSchema),
  since: z.string(),
});

export type InstanceMetrics = z.infer<typeof instanceMetricsSchema>;

/**
 * The registry as a plain list — every key the operator surface may emit.
 * Derived from the schema so the two cannot drift. A test cross-checks this
 * against the actual `instance_metrics` output and against a deny-list of
 * content-bearing keys.
 */
export const INSTANCE_METRICS_KEYS = Object.keys(
  instanceMetricsSchema.shape
) as (keyof InstanceMetrics)[];

/**
 * Keys that must NEVER appear on the operator surface because they carry, or
 * could reconstruct, memory content. The negative test asserts the registry
 * intersects this set at zero. `top_facts` is the concrete one the vitrine
 * exposes and the operator surface must not.
 */
export const FORBIDDEN_CONTENT_KEYS = ['top_facts', 'content'] as const;

/** One per-day point of `instance_metrics_series`. */
export const instanceMetricsSeriesPointSchema = z.object({
  date: z.string(),
  recall_calls: z.number().int().nonnegative(),
  captured: z.number().int().nonnegative(),
  saved_tokens: z.number().nonnegative(),
  write_tokens: z.number().nonnegative(),
  briefing_hits: z.number().int().nonnegative(),
  briefing_total: z.number().int().nonnegative(),
  judged: z.number().int().nonnegative(),
  relevant: z.number().int().nonnegative(),
  used: z.number().int().nonnegative(),
  users_active: z.number().int().nonnegative(),
});

export const instanceMetricsSeriesSchema = z.array(
  instanceMetricsSeriesPointSchema
);

export type InstanceMetricsSeriesPoint = z.infer<
  typeof instanceMetricsSeriesPointSchema
>;
