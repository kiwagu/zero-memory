import { describe, expect, it } from 'vitest';

import { computeWeeklyDigest, type MetricsPoint } from './insights.js';

/** A dense per-day point; override only the fields a case cares about. */
function point(date: string, over: Partial<MetricsPoint> = {}): MetricsPoint {
  return {
    date,
    recall_calls: 0,
    captured: 0,
    saved_tokens: 0,
    write_tokens: 0,
    briefing_hits: 0,
    briefing_total: 0,
    judged: 0,
    relevant: 0,
    used: 0,
    ...over,
  };
}

/** 14 consecutive days ending 2026-07-14 (anchor). */
function fortnight(
  over: (day: number) => Partial<MetricsPoint>
): MetricsPoint[] {
  const days: MetricsPoint[] = [];
  for (let i = 0; i < 14; i++) {
    const d = new Date(Date.UTC(2026, 6, 1 + i)).toISOString().slice(0, 10);
    days.push(point(d, over(i)));
  }
  return days;
}

describe('computeWeeklyDigest', () => {
  it('returns null when the series does not span two weeks', () => {
    const week = Array.from({ length: 7 }, (_, i) =>
      point(new Date(Date.UTC(2026, 6, 1 + i)).toISOString().slice(0, 10), {
        captured: 3,
      })
    );
    expect(computeWeeklyDigest(week)).toBeNull();
  });

  it('returns null on an empty series', () => {
    expect(computeWeeklyDigest([])).toBeNull();
  });

  it('returns null when the whole two-week window is silent', () => {
    expect(computeWeeklyDigest(fortnight(() => ({})))).toBeNull();
  });

  it('diffs the last 7 days against the prior 7 (counts + tokens)', () => {
    // days 0-6 (last week): captured 1 each = 7; days 7-13 (this week): 2 each = 14.
    const digest = computeWeeklyDigest(
      fortnight((i) => ({
        captured: i < 7 ? 1 : 2,
        used: i < 7 ? 0 : 3,
        saved_tokens: i < 7 ? 10 : 20,
        write_tokens: i < 7 ? 0 : 5,
      }))
    );
    expect(digest).not.toBeNull();
    expect(digest!.captured).toEqual({ current: 14, delta: 7 }); // 14 - 7
    expect(digest!.fired).toEqual({ current: 21, delta: 21 }); // 21 - 0
    expect(digest!.tokens).toEqual({ current: 175, delta: 105 }); // 175 - 70
  });

  it('computes hit-rate as percent with a percentage-point delta', () => {
    // last week: 1/2 = 50%; this week: 6/8 = 75% → +25pp.
    const digest = computeWeeklyDigest(
      fortnight((i) => ({
        briefing_hits: i < 7 ? (i === 0 ? 1 : 0) : i === 7 ? 6 : 0,
        briefing_total: i < 7 ? (i === 0 ? 2 : 0) : i === 7 ? 8 : 0,
      }))
    );
    expect(digest!.hitRate).toEqual({ current: 75, delta: 25 });
  });

  it('leaves the hit-rate delta null when the prior week had no briefings', () => {
    const digest = computeWeeklyDigest(
      fortnight((i) => ({
        captured: 1, // keep the window non-silent
        briefing_hits: i === 7 ? 3 : 0,
        briefing_total: i === 7 ? 4 : 0,
      }))
    );
    expect(digest!.hitRate).toEqual({ current: 75, delta: null });
  });

  it('is robust to missing days (sparse series)', () => {
    // Only two active days, one in each week — still splits correctly by date.
    const digest = computeWeeklyDigest([
      point('2026-07-02', { captured: 4 }), // last week
      point('2026-07-14', { captured: 9 }), // this week (anchor)
    ]);
    expect(digest!.captured).toEqual({ current: 9, delta: 5 });
  });
});
