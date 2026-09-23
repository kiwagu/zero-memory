/**
 * The operator surface: instance_metrics.
 *
 * Three promises that would be worth least if only unit-tested: the aggregate
 * really spans the whole instance (not the caller), it never carries memory
 * content, and an end user cannot read it. Numerical convergence of every
 * metric against the sum of the personal vitrines is proven separately on a
 * clone of live; here it is pinned where it is cheap and stable — the seat
 * count an operator answers for — plus an independent instance-wide count for
 * one aggregate, both read in the same database snapshot as the aggregate, and
 * the two structural guarantees.
 */
import { spawnSync } from 'node:child_process';

import { createClient } from '@supabase/supabase-js';
import { expect, test } from '@playwright/test';

import { e2eEnv } from '../helpers/env.js';
import { seedInsightsUsage } from '../helpers/insights.js';
import {
  passwordGrantToken,
  provisionE2EUser,
  userRestClient,
} from '../helpers/users.js';

const admin = () =>
  createClient(e2eEnv.supabaseUrl, e2eEnv.supabaseServiceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

/**
 * The aggregate next to independent instance-wide counts, read from ONE
 * snapshot: a repeatable-read transaction, so the function's own queries and
 * the counts beside it see the same rows. Sibling specs write, invalidate and
 * restore memories while this runs; two separate reads could straddle any of
 * those, and no bracket of counts taken around the call survives a row that
 * disappears and comes back in between.
 */
const snapshotCounts = (): {
  users_total: number;
  profiles: number;
  live_share_num: number;
  live: number;
} => {
  const result = spawnSync(
    'docker',
    [
      'run',
      '--rm',
      '--network',
      'host',
      '-i',
      'supabase/postgres:17.6.1.136',
      'psql',
      'postgresql://postgres:postgres@127.0.0.1:55332/postgres',
      '-v',
      'ON_ERROR_STOP=1',
      '-qtA',
      '-c',
      'begin transaction isolation level repeatable read read only; ' +
        "select json_build_object('users_total', (m->>'users_total')::int, " +
        "'profiles', (select count(*) from public.profiles), " +
        "'live_share_num', (m->>'live_share_num')::int, " +
        "'live', (select count(*) from public.memories " +
        'where invalidated_at is null and superseded_by is null)) ' +
        'from (select public.instance_metrics(30) as m) s; commit;',
    ],
    { encoding: 'utf8' }
  );
  if (result.status !== 0) {
    throw new Error(`psql failed: ${result.stderr}`);
  }
  return JSON.parse(result.stdout.trim()) as {
    users_total: number;
    profiles: number;
    live_share_num: number;
    live: number;
  };
};

test.describe('operator surface: instance_metrics', () => {
  test('@smoke spans the instance, stays content-free, and is denied to end users', async () => {
    // Two users with activity, so the aggregate is genuinely over more than
    // the caller.
    const a = await provisionE2EUser('instance-metrics-a@zm.e2e');
    const b = await provisionE2EUser('instance-metrics-b@zm.e2e');
    await seedInsightsUsage(a);
    await seedInsightsUsage(b);

    // Convergence where it is stable: the seat count equals every profile,
    // and live_share_num every live memory of the instance — the aggregate
    // spans the whole instance, not the caller. Read in one snapshot, so the
    // comparison is exact however busy the sibling specs are.
    const counts = snapshotCounts();
    expect(counts.users_total).toBe(counts.profiles);
    expect(counts.live_share_num).toBe(counts.live);

    const { data: inst, error } = await admin().rpc('instance_metrics', {
      p_days: 30,
    });
    expect(error).toBeNull();
    const m = inst as Record<string, unknown>;

    // Content-free: the one content-bearing field the vitrine exposes must not
    // cross onto the operator surface.
    expect(m).not.toHaveProperty('top_facts');
    // Seats are present and are the operator-only figures.
    expect(m).toHaveProperty('users_total');
    expect(m).toHaveProperty('users_active');

    // An end user, even authenticated, is denied the operator surface.
    const token = await passwordGrantToken(a);
    const { error: denied } = await userRestClient(token).rpc(
      'instance_metrics',
      { p_days: 30 }
    );
    expect(denied).not.toBeNull();

    // The series spans exactly the requested window and reads the rollup.
    const { data: series, error: seriesError } = await admin().rpc(
      'instance_metrics_series',
      { p_days: 7 }
    );
    expect(seriesError).toBeNull();
    expect(Array.isArray(series)).toBe(true);
    expect((series as unknown[]).length).toBe(7);
  });
});
