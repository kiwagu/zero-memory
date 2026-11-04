import { describe, expect, it } from 'vitest';

import { FIT_RESERVE_CHARS, fitResult, type FitPlan } from './result-budget.js';

interface Row {
  id: string;
  content: string;
  truncated?: boolean;
}

const row = (id: string, chars: number): Row => ({
  id,
  content: 'x'.repeat(chars),
});

const rows = (prefix: string, count: number, chars: number): Row[] =>
  Array.from({ length: count }, (_, i) => row(`${prefix}${i}`, chars));

/** The size the client sees: the JSON text, as asToolResult mirrors it. */
const size = (payload: unknown): number => JSON.stringify(payload).length;

const PLAN: FitPlan = {
  drop: [{ list: 'secondary' }, { list: 'primary', floor: 2 }],
};

describe('fitResult', () => {
  it('leaves a result inside the budget untouched and unmarked', () => {
    const payload = {
      primary: rows('p', 3, 100),
      secondary: rows('s', 3, 100),
    };
    const budget = size(payload);

    const fitted = fitResult({
      payload,
      budget,
      source: 'default',
      plan: PLAN,
      measure: size,
    });

    expect(fitted.payload).toEqual(payload);
    expect(fitted.fit).toBeNull();
  });

  it('acknowledges a reported max_chars even when nothing had to go', () => {
    const payload = { primary: rows('p', 3, 100), secondary: [] as Row[] };

    const fitted = fitResult({
      payload,
      budget: 10_000,
      source: 'call',
      plan: PLAN,
      measure: size,
    });

    expect(fitted.payload).toEqual(payload);
    expect(fitted.fit).toEqual({
      budget: 10_000,
      source: 'call',
      chars: size(payload),
      delivered: size(payload),
      omitted: {},
      clipped: 0,
    });
  });

  it('trims only once the result passes the budget by one character', () => {
    const payload = {
      primary: rows('p', 4, 2_000),
      secondary: rows('s', 4, 2_000),
    };
    const atLine = size(payload);

    expect(
      fitResult({
        payload,
        budget: atLine,
        source: 'default',
        plan: PLAN,
        measure: size,
      }).fit
    ).toBeNull();
    const over = fitResult({
      payload,
      budget: atLine - 1,
      source: 'default',
      plan: PLAN,
      measure: size,
    });
    // One row past the line costs one row, not the whole list.
    expect(over.fit?.omitted).toEqual({ secondary: 1 });
  });

  it('sheds lists from the tail in plan order, keeping each list a head of its own order', () => {
    const payload = {
      primary: rows('p', 6, 2_000),
      secondary: rows('s', 6, 2_000),
    };
    // Room for five primary rows: all six secondary rows must go, then one
    // primary row.
    const budget = 5 * 2_100 + FIT_RESERVE_CHARS;

    const fitted = fitResult({
      payload,
      budget,
      source: 'default',
      plan: PLAN,
      measure: size,
    });

    expect(fitted.payload.secondary).toEqual([]);
    expect(fitted.payload.primary.map((r) => r.id)).toEqual([
      'p0',
      'p1',
      'p2',
      'p3',
      'p4',
    ]);
    expect(size(fitted.payload)).toBeLessThanOrEqual(
      budget - FIT_RESERVE_CHARS
    );
    expect(fitted.fit).toEqual({
      budget,
      source: 'default',
      chars: size(payload),
      delivered: size(fitted.payload),
      omitted: { secondary: 6, primary: 1 },
      clipped: 0,
    });
  });

  it('never drops a list below its floor, and reports a result that still does not fit', () => {
    const payload = {
      primary: rows('p', 3, 5_000),
      secondary: rows('s', 2, 100),
    };

    const fitted = fitResult({
      payload,
      budget: 4_000,
      source: 'session',
      plan: PLAN,
      measure: size,
    });

    expect(fitted.payload.primary.map((r) => r.id)).toEqual(['p0', 'p1']);
    expect(fitted.payload.secondary).toEqual([]);
    expect(fitted.fit?.delivered).toBeGreaterThan(4_000);
    expect(fitted.fit?.omitted).toEqual({ secondary: 2, primary: 1 });
  });

  it('shortens content past the top rows before dropping any row, and marks what it shortened', () => {
    const payload = { primary: rows('p', 6, 3_000), secondary: [] as Row[] };
    const plan: FitPlan = {
      clip: [{ list: 'primary', keepWhole: 2, toChars: 500 }],
      drop: [{ list: 'primary', floor: 2 }],
    };
    const budget = 2 * 3_100 + 4 * 600 + FIT_RESERVE_CHARS;

    const fitted = fitResult({
      payload,
      budget,
      source: 'default',
      plan,
      measure: size,
    });

    const [first, second, ...rest] = fitted.payload.primary;
    expect(first?.content).toHaveLength(3_000);
    expect(first?.truncated).toBeUndefined();
    expect(second?.content).toHaveLength(3_000);
    expect(rest).toHaveLength(4);
    for (const clipped of rest) {
      expect(clipped.truncated).toBe(true);
      expect(clipped.content.length).toBeLessThanOrEqual(501);
    }
    expect(fitted.fit).toMatchObject({ omitted: {}, clipped: 4 });
    // The caller's payload is not mutated.
    expect(payload.primary[5]?.content).toHaveLength(3_000);
  });

  it('counts what else the result carries per row, such as a resource link per memory', () => {
    const payload = { primary: rows('p', 10, 100), secondary: [] as Row[] };
    const linkChars = 1_000;
    const measure = (p: typeof payload): number =>
      size(p) + p.primary.length * linkChars;
    const plan: FitPlan = {
      drop: [{ list: 'primary', rowExtraChars: linkChars }],
    };
    const budget = 6 * 1_150 + FIT_RESERVE_CHARS;

    const fitted = fitResult({
      payload,
      budget,
      source: 'default',
      plan,
      measure,
    });

    expect(measure(fitted.payload)).toBeLessThanOrEqual(
      budget - FIT_RESERVE_CHARS
    );
    expect(fitted.payload.primary.length).toBeGreaterThanOrEqual(5);
    expect(fitted.fit?.delivered).toBe(measure(fitted.payload));
  });
});
