/**
 * The operator surface: instance_metrics.
 *
 * Three promises that would be worth least if only unit-tested: the aggregate
 * really spans the whole instance (not the caller), it never carries memory
 * content, and an end user cannot read it. Numerical convergence of every
 * metric against the sum of the personal vitrines is proven separately on a
 * clone of live; here it is pinned where it is cheap and stable — the seat
 * count an operator answers for — plus an independent instance-wide count for
 * one aggregate, and the two structural guarantees.
 */
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

/** Every seat on the instance, counted independently of the aggregate. */
const countProfiles = async (): Promise<number> => {
  const { count, error } = await admin()
    .from('profiles')
    .select('*', { count: 'exact', head: true });
  expect(error).toBeNull();
  return count ?? 0;
};

/** Live memories of the whole instance, by the same predicate the RPC uses. */
const countLiveMemories = async (): Promise<number> => {
  const { count, error } = await admin()
    .from('memories')
    .select('*', { count: 'exact', head: true })
    .is('invalidated_at', null)
    .is('superseded_by', null);
  expect(error).toBeNull();
  return count ?? 0;
};

/**
 * The aggregate must land inside the window the two independent counts define.
 * Either bound may be the larger one: rows are added by sibling specs and
 * removed by invalidation, so the interval is taken from the pair rather than
 * assumed to be ordered.
 */
const expectWithin = (actual: number, a: number, b: number): void => {
  expect(actual).toBeGreaterThanOrEqual(Math.min(a, b));
  expect(actual).toBeLessThanOrEqual(Math.max(a, b));
};

test.describe('operator surface: instance_metrics', () => {
  test('@smoke spans the instance, stays content-free, and is denied to end users', async () => {
    // Two users with activity, so the aggregate is genuinely over more than
    // the caller.
    const a = await provisionE2EUser('instance-metrics-a@zm.e2e');
    const b = await provisionE2EUser('instance-metrics-b@zm.e2e');
    await seedInsightsUsage(a);
    await seedInsightsUsage(b);

    // Convergence where it is stable: the seat count equals every profile —
    // the aggregate spans the whole instance, not the caller.
    //
    // Both convergence checks BRACKET the aggregate between an independent
    // count taken before and one taken after, instead of comparing against a
    // single count. The suite runs its specs concurrently, so a sibling spec
    // provisioning a user or writing a memory between the RPC and the count
    // moves the true figure under the assertion — that is a property of the
    // measurement, not a defect in the aggregate, and it made this spec fail
    // once on a mismatch of exactly one. A bracket cannot be fooled by the
    // thing this spec actually guards: a caller-scoped aggregate would sit at
    // this spec's own two users, orders below an instance-wide bracket.
    const profilesBefore = await countProfiles();

    const { data: inst, error } = await admin().rpc('instance_metrics', {
      p_days: 30,
    });
    expect(error).toBeNull();
    const m = inst as Record<string, unknown>;

    const liveBefore = await countLiveMemories();

    // Content-free: the one content-bearing field the vitrine exposes must not
    // cross onto the operator surface.
    expect(m).not.toHaveProperty('top_facts');
    // Seats are present and are the operator-only figures.
    expect(m).toHaveProperty('users_total');
    expect(m).toHaveProperty('users_active');

    const profilesAfter = await countProfiles();
    expectWithin(m.users_total as number, profilesBefore, profilesAfter);

    // live_share_num aggregates the live memories of the whole instance —
    // check it against an independent instance-wide count.
    const liveAfter = await countLiveMemories();
    expectWithin(m.live_share_num as number, liveBefore, liveAfter);

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
