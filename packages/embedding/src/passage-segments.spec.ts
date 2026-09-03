import { describe, expect, it } from 'vitest';

import {
  EMBEDDING_WINDOW_CHARS,
  MAX_OVERFLOW_WINDOWS,
  WINDOW_OVERLAP_CHARS,
  overflowWindowCount,
  passageCoverageShortfall,
  passageWindows,
} from './passage-segments.js';

const body = (chars: number): string => 'a'.repeat(chars);

/** Every character index the segments after the primary one actually cover. */
const overflowCoverage = (content: string): Set<number> => {
  const covered = new Set<number>();
  const stride = EMBEDDING_WINDOW_CHARS - WINDOW_OVERLAP_CHARS;
  passageWindows(content)
    .slice(1)
    .forEach((_window, index) => {
      const start = stride * (index + 1);
      for (
        let i = start;
        i < Math.min(start + EMBEDDING_WINDOW_CHARS, content.length);
        i++
      ) {
        covered.add(i);
      }
    });
  return covered;
};

describe('passageWindows', () => {
  it('embeds a passage that fits the window as a single primary vector', () => {
    const content = body(EMBEDDING_WINDOW_CHARS - 1);
    expect(passageWindows(content)).toEqual([{ text: content, charStart: 0 }]);
    expect(overflowWindowCount(content)).toBe(0);
  });

  it('keeps the primary segment as the WHOLE content', () => {
    // The model truncates it; passing the full content is what makes stored
    // primary vectors reproducible without a re-embed.
    const content = body(50_000);
    expect(passageWindows(content)[0]!.text).toBe(content);
  });

  it('adds as many windows as the length needs, not a fixed number', () => {
    const stride = EMBEDDING_WINDOW_CHARS - WINDOW_OVERLAP_CHARS;
    expect(overflowWindowCount(body(EMBEDDING_WINDOW_CHARS + 1))).toBe(1);
    expect(overflowWindowCount(body(stride * 2 + 1))).toBe(2);
    expect(overflowWindowCount(body(stride * 5 + 1))).toBe(5);
  });

  it('covers every character of a long passage', () => {
    const content = body(stride5());
    const covered = overflowCoverage(content);
    // Everything past the window the primary vector certainly reaches.
    for (let i = EMBEDDING_WINDOW_CHARS; i < content.length; i++) {
      expect(covered.has(i), `character ${i} is in no window`).toBe(true);
    }
  });

  it('overlaps neighbouring windows so no sentence falls between them', () => {
    const content = body(10_000);
    const segments = passageWindows(content).slice(1);
    const stride = EMBEDDING_WINDOW_CHARS - WINDOW_OVERLAP_CHARS;
    // Consecutive starts advance by less than a full window: the difference
    // is exactly the shared span.
    expect(EMBEDDING_WINDOW_CHARS - stride).toBe(WINDOW_OVERLAP_CHARS);
    expect(segments.length).toBeGreaterThan(1);
  });

  it('ends the last window at the end of the passage', () => {
    const content = `${body(5000)}THE INSTRUCTION THAT SITS AT THE VERY END`;
    const last = passageWindows(content).at(-1)!.text;
    expect(content.endsWith(last)).toBe(true);
    expect(last).toContain('THE INSTRUCTION THAT SITS AT THE VERY END');
  });

  it('never exceeds the window size in any segment but the primary', () => {
    for (const w of passageWindows(body(20_000)).slice(1)) {
      expect(w.text.length).toBeLessThanOrEqual(EMBEDDING_WINDOW_CHARS);
    }
  });

  it('states where each window starts so a reader never re-derives it', () => {
    const windows = passageWindows(body(8000));
    expect(windows[0]!.charStart).toBe(0);
    for (const w of windows.slice(1)) {
      expect(body(8000).slice(w.charStart, w.charStart + w.text.length)).toBe(
        w.text
      );
    }
  });

  it('reports no shortfall for any passage of a sane size', () => {
    expect(passageCoverageShortfall(body(200))).toBe(0);
    expect(passageCoverageShortfall(body(12_000))).toBe(0);
  });

  it('bounds the fan-out and REPORTS the ending it could not reach', () => {
    const stride = EMBEDDING_WINDOW_CHARS - WINDOW_OVERLAP_CHARS;
    const beyond = stride * (MAX_OVERFLOW_WINDOWS + 10);
    expect(overflowWindowCount(body(beyond))).toBe(MAX_OVERFLOW_WINDOWS);
    // The cap is visible rather than silent — that is the whole point of it
    // being reported instead of the ending just going missing.
    expect(passageCoverageShortfall(body(beyond))).toBeGreaterThan(0);
  });
});

/** A length that needs five overflow windows. */
const stride5 = (): number =>
  (EMBEDDING_WINDOW_CHARS - WINDOW_OVERLAP_CHARS) * 5 + 137;
