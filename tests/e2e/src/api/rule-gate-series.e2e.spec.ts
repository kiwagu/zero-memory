/**
 * The rule gate's numbers, end to end through the SQL that reads them.
 *
 * The gate writes its decisions into usage-event metadata under string keys,
 * and the daily series reads them back by the same keys. Nothing else ties the
 * two together: a renamed key or a wrong path would quietly read zero. So this
 * spec seeds the event shapes the server writes for one throwaway user and
 * pins the exact numbers on every reader — the per-user series computed live
 * and served from the rollup, the operator series, and the per-rule breakdown.
 */
import { expect, test } from '@playwright/test';

import { admin, psql } from '../helpers/board-store.js';
import { RULE_GATE_SERIES_KEYS } from '../helpers/insights.js';
import {
  passwordGrantToken,
  provisionE2EUser,
  userRestClient,
} from '../helpers/users.js';

type RuleGateKey = (typeof RULE_GATE_SERIES_KEYS)[number];
type RuleGateDay = Record<RuleGateKey, number>;

const RULE_A = 'rlc_e2ea000000000000.01e2eg8te0';
const RULE_B = 'rlc_e2eb000000000000.01e2eg8te0';
const RULE_C = 'rlc_e2ec000000000000.01e2eg8te0';
const RULE_PINNED = 'rlc_e2ep000000000000.01e2eg8te0';

const gateBlock = (block: {
  latency: number;
  unavailable: boolean;
  baseline: number;
  delivered: number;
  levels: { full: number; gate: number; headline: number };
  rules: Array<{
    id: string;
    p: number | null;
    level: 'full' | 'gate' | 'headline';
    chars: number;
    pinned: boolean;
  }>;
}): Record<string, unknown> => ({
  mode: 'live',
  provider: 'typesafe',
  model: 'e2e-judge',
  latency_ms: block.latency,
  judge_unavailable: block.unavailable,
  bands: { hi: 0.7, lo: 0.3 },
  chars_baseline: block.baseline,
  chars_delivered: block.delivered,
  levels: block.levels,
  rules: block.rules,
});

const day = (values: Partial<RuleGateDay>): RuleGateDay =>
  Object.fromEntries(
    RULE_GATE_SERIES_KEYS.map((key) => [key, values[key] ?? 0])
  ) as RuleGateDay;

const pick = (point: Record<string, unknown>): RuleGateDay =>
  Object.fromEntries(
    RULE_GATE_SERIES_KEYS.map((key) => [key, point[key]])
  ) as RuleGateDay;

// The prior day carries only a found read and a refusal, so it is present in
// the series through the rule-gate measures alone.
const PRIOR_DAY = day({ rule_fetches: 1, guard_refusals: 1 });
// Today: two gated calls. Unpinned entries judged: A, B, C on the first and
// A, B on the second (5); of those whole: A on the first, A and B on the
// second (3). The pinned entry and the id-less rule counted in the first
// call's level totals are in neither. The second call's judge did not answer.
const TODAY = day({
  rule_gate_calls: 2,
  rules_chars_baseline: 1800,
  rules_chars_delivered: 1200,
  rules_full: 3,
  rules_judged: 5,
  rule_fetches: 1,
  guard_refusals: 3,
  judge_latency_ms_sum: 120,
  judge_unavailable: 1,
  judge_input_tokens: 750,
});

const seedRuleGateUsage = async (ownerId: string): Promise<void> => {
  const startOfToday = new Date();
  startOfToday.setUTCHours(0, 0, 0, 0);
  const priorDay = new Date(startOfToday.getTime() - 12 * 3600 * 1000);

  const { error } = await admin()
    .from('usage_events')
    .insert(
      [
        {
          user_id: ownerId,
          event_type: 'mcp_tool_call',
          agent_name: 'e2e-agent',
          metadata: {
            tool: 'build_context',
            returned: 0,
            returned_ids: [],
            rule_gate: gateBlock({
              latency: 120,
              unavailable: false,
              baseline: 1300,
              delivered: 700,
              // Whole: the pinned rule, A and one rule without an id.
              levels: { full: 3, gate: 1, headline: 1 },
              rules: [
                {
                  id: RULE_PINNED,
                  p: null,
                  level: 'full',
                  chars: 300,
                  pinned: true,
                },
                {
                  id: RULE_A,
                  p: 0.9,
                  level: 'full',
                  chars: 400,
                  pinned: false,
                },
                {
                  id: RULE_B,
                  p: 0.5,
                  level: 'gate',
                  chars: 150,
                  pinned: false,
                },
                {
                  id: RULE_C,
                  p: 0.1,
                  level: 'headline',
                  chars: 50,
                  pinned: false,
                },
              ],
            }),
          },
        },
        {
          user_id: ownerId,
          event_type: 'mcp_tool_call',
          agent_name: 'e2e-agent',
          metadata: {
            tool: 'recall',
            returned: 0,
            returned_ids: [],
            rule_gate: gateBlock({
              latency: 0,
              unavailable: true,
              baseline: 500,
              delivered: 500,
              levels: { full: 2, gate: 0, headline: 0 },
              rules: [
                {
                  id: RULE_A,
                  p: null,
                  level: 'full',
                  chars: 300,
                  pinned: false,
                },
                {
                  id: RULE_B,
                  p: null,
                  level: 'full',
                  chars: 200,
                  pinned: false,
                },
              ],
            }),
          },
        },
        // A read that found its rule counts; one that did not is noise.
        {
          user_id: ownerId,
          event_type: 'mcp_tool_call',
          metadata: { tool: 'resource:rule', rule_id: RULE_C, found: true },
        },
        {
          user_id: ownerId,
          event_type: 'mcp_tool_call',
          metadata: { tool: 'resource:rule', rule_id: RULE_B, found: false },
        },
        {
          user_id: ownerId,
          event_type: 'ingest_chunk',
          metadata: {
            guard_refusals: ['commit-guard', 'docs-guard', 'commit-guard'],
          },
        },
        // The judge's tokens; another purpose's extraction is not the judge's.
        {
          user_id: ownerId,
          event_type: 'llm_extraction',
          quantity: 750,
          unit: 'tokens',
          metadata: { purpose: 'rule_gate', provider: 'typesafe' },
        },
        {
          user_id: ownerId,
          event_type: 'llm_extraction',
          quantity: 999,
          unit: 'tokens',
          metadata: { purpose: 'extract' },
        },
        {
          user_id: ownerId,
          event_type: 'mcp_tool_call',
          occurred_at: priorDay.toISOString(),
          metadata: { tool: 'resource:rule', rule_id: RULE_A, found: true },
        },
        {
          user_id: ownerId,
          event_type: 'ingest_chunk',
          occurred_at: priorDay.toISOString(),
          metadata: { guard_refusals: ['docs-guard'] },
        },
        // Rows name different columns; an absent one takes its default (the
        // current time, a count of 1) rather than null.
      ],
      { defaultToNull: false }
    );
  if (error) {
    throw new Error(`rule gate seed: insert usage failed: ${error.message}`);
  }
};

/**
 * The operator series next to every OTHER user's stored days, read in one
 * repeatable-read snapshot, so the difference is exactly this user's share
 * however busy the sibling specs are.
 */
const operatorShare = (ownerId: string): RuleGateDay[] => {
  const sums = RULE_GATE_SERIES_KEYS.map(
    (key) => `sum(u.${key})::int as ${key}`
  ).join(', ');
  const row = psql(
    'begin transaction isolation level repeatable read read only; ' +
      "select json_build_object('instance', public.instance_metrics_series(2), " +
      "'others', (select coalesce(json_object_agg(to_char(o.day, 'YYYY-MM-DD'), " +
      `row_to_json(o)), '{}'::json) from (select u.day, ${sums} ` +
      `from public.usage_daily u where u.user_id <> '${ownerId}' ` +
      "and u.day >= (date_trunc('day', now()) - interval '1 day')::date " +
      'group by u.day) o)); commit;'
  )
    .split('\n')
    .find((line) => line.startsWith('{'));
  if (!row) {
    throw new Error('operator series snapshot returned no row');
  }
  const { instance, others } = JSON.parse(row) as {
    instance: Array<Record<string, unknown>>;
    others: Record<string, Record<string, number>>;
  };
  return instance.map((point) => {
    const other = others[point.date as string] ?? {};
    return Object.fromEntries(
      RULE_GATE_SERIES_KEYS.map((key) => [
        key,
        (point[key] as number) - (other[key] ?? 0),
      ])
    ) as RuleGateDay;
  });
};

test.describe('rule gate series', () => {
  test('pins the gate numbers on every reader', async () => {
    const user = await provisionE2EUser('rule-gate-series@zm.e2e');
    const client = admin();
    const { data: profile, error: profileError } = await client
      .from('profiles')
      .select('id')
      .eq('user_id', user.id)
      .single();
    expect(profileError).toBeNull();
    const ownerId = (profile as { id: string }).id;

    try {
      await seedRuleGateUsage(ownerId);
      const rest = userRestClient(await passwordGrantToken(user));

      // Live: nothing rolled for this user yet, so both days are computed.
      const { data: live, error: liveError } = await rest.rpc(
        'dashboard_metrics_series',
        { p_days: 2 }
      );
      expect(liveError).toBeNull();
      const livePoints = live as Array<Record<string, unknown>>;
      expect(livePoints).toHaveLength(2);
      expect(pick(livePoints[0]!)).toEqual(PRIOR_DAY);
      expect(pick(livePoints[1]!)).toEqual(TODAY);
      expect(livePoints[1]!.recall_calls).toBe(2);

      // Rolled: the same numbers once the rollup has stored both days.
      const { error: rollupError } = await client.rpc('usage_daily_rollup', {
        p_days: 2,
      });
      expect(rollupError).toBeNull();
      const { data: rolled, error: rolledError } = await rest.rpc(
        'dashboard_metrics_series',
        { p_days: 2 }
      );
      expect(rolledError).toBeNull();
      const rolledPoints = rolled as Array<Record<string, unknown>>;
      expect(rolledPoints.map(pick)).toEqual([PRIOR_DAY, TODAY]);

      // Operator: this user's share of the instance-wide sums.
      expect(operatorShare(ownerId)).toEqual([PRIOR_DAY, TODAY]);

      // Per rule: unpinned entries only, found reads only, stable order.
      const { data: stats, error: statsError } = await rest.rpc(
        'rule_gate_stats',
        { p_days: 2 }
      );
      expect(statsError).toBeNull();
      expect(stats).toEqual({
        rules: [
          {
            rule_id: RULE_A,
            calls: 2,
            full: 2,
            gate: 0,
            headline: 0,
            mean_p: 0.9,
            fetches: 1,
          },
          {
            rule_id: RULE_B,
            calls: 2,
            full: 1,
            gate: 1,
            headline: 0,
            mean_p: 0.5,
            fetches: 0,
          },
          {
            rule_id: RULE_C,
            calls: 1,
            full: 0,
            gate: 0,
            headline: 1,
            mean_p: 0.1,
            fetches: 1,
          },
        ],
        refusals: [
          { guard: 'commit-guard', count: 2 },
          { guard: 'docs-guard', count: 2 },
        ],
      });
    } finally {
      await client.from('usage_events').delete().eq('user_id', ownerId);
      await client.from('usage_daily').delete().eq('user_id', ownerId);
    }
  });
});
