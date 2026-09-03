import { describe, expect, it } from 'vitest';

import {
  DEFAULT_JUDGE_RESCAN_CONFIG,
  foldRescan,
  type JudgeRescanResult,
} from './judge-rescan.js';

const empty = (): JudgeRescanResult => ({
  model: 'test-judge',
  candidates: 3,
  rescanned: 0,
  pairsJudged: 0,
  autoResolved: 0,
  queued: 0,
  stoppedOnQueueCap: false,
});

describe('foldRescan', () => {
  it('counts a subject the scan actually reached', () => {
    const folded = foldRescan(empty(), {
      scanned: 1,
      pairsJudged: 2,
      autoResolved: 1,
      queued: 1,
    });

    expect(folded).toMatchObject({
      rescanned: 1,
      pairsJudged: 2,
      autoResolved: 1,
      queued: 1,
    });
  });

  it('does not count a subject that vanished before the scan', () => {
    // scanOne returns scanned: 0 when the memory was invalidated between the
    // rollup and the scan. Counting it would report work that never happened.
    const folded = foldRescan(empty(), {
      scanned: 0,
      pairsJudged: 0,
      autoResolved: 0,
      queued: 0,
    });

    expect(folded.rescanned).toBe(0);
  });

  it('accumulates across subjects and leaves the run header alone', () => {
    const one = foldRescan(empty(), {
      scanned: 1,
      pairsJudged: 3,
      autoResolved: 0,
      queued: 2,
    });
    const two = foldRescan(one, {
      scanned: 1,
      pairsJudged: 1,
      autoResolved: 1,
      queued: 0,
    });

    expect(two).toEqual({
      model: 'test-judge',
      candidates: 3,
      rescanned: 2,
      pairsJudged: 4,
      autoResolved: 1,
      queued: 2,
      stoppedOnQueueCap: false,
    });
  });

  it('caps the spend by subjects per run, not by pairs', () => {
    // The guard makes the work finite; this default is what keeps ONE run
    // bounded, so a change to it is a deliberate spend decision.
    expect(DEFAULT_JUDGE_RESCAN_CONFIG.maxSubjects).toBeGreaterThan(0);
    expect(DEFAULT_JUDGE_RESCAN_CONFIG.minSurfacings).toBeGreaterThan(1);
  });

  it('caps the hand-triage a run can create', () => {
    // The scarce resource is a person working the queue, so the default has
    // to stay small enough that one run is never a triage session.
    expect(DEFAULT_JUDGE_RESCAN_CONFIG.maxNewQueueRows).toBeGreaterThan(0);
    expect(DEFAULT_JUDGE_RESCAN_CONFIG.maxNewQueueRows).toBeLessThanOrEqual(
      DEFAULT_JUDGE_RESCAN_CONFIG.maxSubjects
    );
  });

  it('reaches the triage cap on the pairs it already queued', () => {
    // The detector compares the running total against the cap BEFORE taking
    // the next subject, so the fold has to carry queued rows faithfully —
    // an undercount here would let a run keep filling the queue.
    const afterFirst = foldRescan(empty(), {
      scanned: 1,
      pairsJudged: 3,
      autoResolved: 0,
      queued: 2,
    });

    expect(afterFirst.queued).toBe(DEFAULT_JUDGE_RESCAN_CONFIG.maxNewQueueRows);
  });
});
