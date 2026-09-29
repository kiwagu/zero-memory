import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { refreshScheduler } from './live-refresh';

describe('refreshing a page on nudges', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('refreshes once for a burst of nudges, after the burst settles', () => {
    const refresh = vi.fn();
    const nudge = refreshScheduler(refresh, { settleMs: 300, maxWaitMs: 2000 });
    nudge();
    vi.advanceTimersByTime(100);
    nudge();
    vi.advanceTimersByTime(100);
    nudge();
    expect(refresh).not.toHaveBeenCalled();
    vi.advanceTimersByTime(300);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('still refreshes during a steady stream of nudges, no later than the longest wait', () => {
    const refresh = vi.fn();
    const nudge = refreshScheduler(refresh, { settleMs: 300, maxWaitMs: 2000 });
    // A nudge every 200 ms for 5 s never lets a burst settle.
    for (let elapsed = 0; elapsed < 5000; elapsed += 200) {
      nudge();
      vi.advanceTimersByTime(200);
    }
    expect(refresh.mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});
