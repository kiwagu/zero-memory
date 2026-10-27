import type { Client } from '@workspace/persistence';
import { describe, expect, it, vi } from 'vitest';

import type { HygieneScanner } from './hygiene-scanner.js';
import {
  DEFAULT_JUDGE_RESCAN_CONFIG,
  foldRescan,
  type JudgeRescanResult,
} from './judge-rescan.js';
import { JudgeRescanDetector } from './judge-rescan-detector.js';

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
});

describe('JudgeRescanDetector', () => {
  it('stops taking subjects once a run has queued its share of hand-triage', async () => {
    // The queue is worked by hand, so the brake is a count of new review
    // rows: once the first subject fills it, the other two are not scanned
    // and stay unstamped, so the next run leads with them.
    const rows = ['mem_a', 'mem_b', 'mem_c'].map((memory_id) => ({
      memory_id,
      owner_id: 'usr_000000000000000a.0000000000',
      surfacings: 12,
      last_surfaced_at: null,
    }));
    const stamped: string[] = [];
    const audited: string[] = [];
    const client = {
      rpc: () => Promise.resolve({ data: rows, error: null }),
      from: () => ({
        upsert: (row: { memory_id: string }) => {
          stamped.push(row.memory_id);
          return Promise.resolve({ error: null });
        },
        insert: (row: { command: string }) => {
          audited.push(row.command);
          return Promise.resolve({ error: null });
        },
      }),
    } as unknown as Client;
    const scanOne = vi.fn().mockResolvedValue({
      scanned: 1,
      pairsJudged: 3,
      autoResolved: 0,
      queued: 2,
    });
    const detector = new JudgeRescanDetector(
      client,
      { scanOne } as unknown as HygieneScanner,
      { ...DEFAULT_JUDGE_RESCAN_CONFIG, maxSubjects: 3, maxNewQueueRows: 2 }
    );

    const result = await detector.detect();

    expect(result).toMatchObject({
      candidates: 3,
      rescanned: 1,
      queued: 2,
      stoppedOnQueueCap: true,
    });
    expect(scanOne).toHaveBeenCalledExactlyOnceWith('mem_a');
    expect(stamped).toEqual(['mem_a']);
    expect(audited).toContain('judge_rescan.queue_cap');
  });
});
