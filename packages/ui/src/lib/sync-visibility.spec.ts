import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createSyncVisibility,
  SYNC_MIN_VISIBLE_MS,
  SYNC_SHOW_AFTER_MS,
} from './sync-visibility.js';

describe('createSyncVisibility', () => {
  let changes: boolean[];
  const visibility = () =>
    createSyncVisibility((visible) => changes.push(visible));

  beforeEach(() => {
    vi.useFakeTimers();
    changes = [];
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('never shows for work that ends before the delay', () => {
    const bar = visibility();
    bar.update(1);
    vi.advanceTimersByTime(SYNC_SHOW_AFTER_MS - 1);
    bar.update(0);
    vi.advanceTimersByTime(10_000);
    expect(changes).toEqual([]);
  });

  it('shows once work has been pending for exactly the delay', () => {
    const bar = visibility();
    bar.update(1);
    vi.advanceTimersByTime(SYNC_SHOW_AFTER_MS - 1);
    expect(changes).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(changes).toEqual([true]);
  });

  it('measures the delay from when work began, not from each new request', () => {
    const bar = visibility();
    bar.update(1);
    vi.advanceTimersByTime(SYNC_SHOW_AFTER_MS / 2);
    bar.update(3);
    vi.advanceTimersByTime(SYNC_SHOW_AFTER_MS / 2);
    expect(changes).toEqual([true]);
  });

  it('stays the minimum time once shown, then hides', () => {
    const bar = visibility();
    bar.update(1);
    vi.advanceTimersByTime(SYNC_SHOW_AFTER_MS);
    vi.advanceTimersByTime(50);
    bar.update(0);
    vi.advanceTimersByTime(SYNC_MIN_VISIBLE_MS - 50 - 1);
    expect(changes).toEqual([true]);
    vi.advanceTimersByTime(1);
    expect(changes).toEqual([true, false]);
  });

  it('hides at once when work ends after the minimum time', () => {
    const bar = visibility();
    bar.update(1);
    vi.advanceTimersByTime(SYNC_SHOW_AFTER_MS + SYNC_MIN_VISIBLE_MS);
    bar.update(0);
    expect(changes).toEqual([true, false]);
  });

  it('keeps showing when work starts again before it would hide', () => {
    const bar = visibility();
    bar.update(1);
    vi.advanceTimersByTime(SYNC_SHOW_AFTER_MS);
    bar.update(0);
    vi.advanceTimersByTime(100);
    bar.update(1);
    vi.advanceTimersByTime(10_000);
    expect(changes).toEqual([true]);
  });
});
