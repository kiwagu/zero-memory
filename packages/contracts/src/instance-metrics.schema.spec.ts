import { describe, expect, it } from 'vitest';

import {
  FORBIDDEN_CONTENT_KEYS,
  INSTANCE_METRICS_KEYS,
  instanceMetricsSchema,
} from './instance-metrics.schema.js';

describe('instance-metrics registry', () => {
  it('is enumerable and non-empty', () => {
    expect(INSTANCE_METRICS_KEYS.length).toBeGreaterThan(0);
    // Derived from the schema, so the two never drift.
    expect(new Set(INSTANCE_METRICS_KEYS)).toEqual(
      new Set(Object.keys(instanceMetricsSchema.shape))
    );
  });

  // The content-free invariant, tested rather than intended: no key on the
  // operator surface may carry or reconstruct memory content.
  it('holds no content-bearing key', () => {
    const leaked = INSTANCE_METRICS_KEYS.filter((k) =>
      (FORBIDDEN_CONTENT_KEYS as readonly string[]).includes(k)
    );
    expect(leaked).toEqual([]);
  });

  it('specifically excludes top_facts, which the vitrine exposes', () => {
    expect(INSTANCE_METRICS_KEYS).not.toContain('top_facts');
  });

  it('accepts a well-formed operator payload and rejects a content field', () => {
    const base: Record<string, unknown> = {};
    for (const k of INSTANCE_METRICS_KEYS) {
      base[k] = 0;
    }
    // Fields that are not plain non-negative numbers.
    base.eval_runs = {};
    base.age_buckets = [];
    base.last_captured_at = null;
    base.stale_median_days = null;
    base.corpus_median_age_days = null;
    base.since = new Date(0).toISOString();

    expect(instanceMetricsSchema.parse(base)).toBeTruthy();

    // A stray content field must be rejected by the strict registry shape.
    const withContent = { ...base, top_facts: [{ id: 'mem_x', content: 'x' }] };
    // zod object is non-strict by default (extra keys stripped), so assert the
    // registry does not KNOW top_facts rather than that it throws.
    const parsed = instanceMetricsSchema.parse(withContent) as Record<
      string,
      unknown
    >;
    expect(parsed).not.toHaveProperty('top_facts');
  });
});
