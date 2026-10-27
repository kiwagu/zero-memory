/**
 * The rule gate's measurement: replays an owner's confirmed probes
 * (`rule_probes`) through three ways of choosing which unpinned rules a
 * session gets whole, and reports how often each gets it right.
 *
 * - `newest` — newest promotion first, whole rules until the budget is spent:
 *   what delivery did before the gate.
 * - `cosine` — the same budget, ranked by E5 similarity between the topic and
 *   the rule's condition (its text when it has none).
 * - the judge — TypeSafe (and SubQ Snap when `SNAPQ_API_KEY` is set), one
 *   request per topic asked exactly as the gate asks it, levelled by the
 *   gate's bands (`ZM_RULE_GATE_HI` / `ZM_RULE_GATE_LO`). A rule the judge
 *   leaves unanswered, and every rule of a topic the judge could not answer
 *   in time, counts as whole — that is what the gate delivers then.
 *
 * Per ranker and rule type (`note`: trigger / trajectory) it prints
 * `hit@full` — the share of `expect = 'full'` probes delivered whole — and
 * `false_full` — the share of `expect = 'headline'` probes delivered whole;
 * for each judge a calibration table (mean p against the share of `full`
 * expectations, in bins of 0.1) and its latency and input tokens per call.
 * The run's JSON lands in the current directory.
 *
 *   SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=… ZM_TYPESAFE_API_KEY=… \
 *     bun scripts/rule-gate-eval.ts --owner usr_…
 *
 * Point it at a stand (the e2e stack, or a production clone restored into the
 * preview stand), never at hosted production.
 */
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { E5SmallEmbeddingService } from '../packages/embedding/src/index.js';
import {
  deliverUnjudged,
  ruleChars,
} from '../packages/memory/src/rule-gate.service.js';
import { readAllPages } from '../packages/persistence/src/paged-read.js';

import {
  fail,
  gateConfig,
  judgeTopic,
  levelOf,
  loadJudgeableRules,
  ownerFlag,
  percentile,
  standClient,
  subqJudge,
  typesafeJudge,
  type NamedJudge,
  type OwnerRule,
  type TopicJudgment,
} from './rule-gate.utils.js';

/** What a session took whole before the gate: rules until this many characters. */
const BUDGET_CHARS = 6_000;
const PROBE_TYPES = ['trigger', 'trajectory'] as const;
type ProbeType = (typeof PROBE_TYPES)[number] | 'untyped';

interface Probe {
  id: string;
  topic: string;
  ruleId: string;
  expect: 'full' | 'headline';
  type: ProbeType;
}

const owner = ownerFlag();
const client = standClient();
const bands = gateConfig();

const typeOf = (note: string | null): ProbeType => {
  const word = note
    ?.trim()
    .toLowerCase()
    .match(/^[a-z]+/u)?.[0];
  return PROBE_TYPES.find((type) => type === word) ?? 'untyped';
};

// ── Probes and rules ─────────────────────────────────────────────────────────

const rules = await loadJudgeableRules(client, owner);
const ruleById = new Map<string, OwnerRule>(
  rules.map((rule) => [rule.id, rule])
);
const probeRows = await readAllPages(
  (from, to) =>
    client
      .from('rule_probes')
      .select('id, topic, rule_id, expect, note')
      .eq('owner_id', owner)
      .is('retired_at', null)
      .order('id', { ascending: true })
      .range(from, to),
  { label: 'probe lookup' }
);
// A probe over a rule that is no longer live (revoked, pinned since, gone)
// cannot be delivered by any ranker and would poison every rate.
const probes: Probe[] = probeRows.flatMap((row): Probe[] =>
  ruleById.has(row.rule_id) &&
  (row.expect === 'full' || row.expect === 'headline')
    ? [
        {
          id: row.id,
          topic: row.topic,
          ruleId: row.rule_id,
          expect: row.expect,
          type: typeOf(row.note),
        },
      ]
    : []
);
const skippedDead = probeRows.length - probes.length;
if (probes.length === 0) {
  fail(
    `no live probes for ${owner} — draft and import them with scripts/rule-probes-draft.ts`
  );
}
const topics = [...new Set(probes.map((probe) => probe.topic))];

// ── Rankers: which rules each one delivers whole, per topic ─────────────────

/** The top of a ranking that fits the budget, whole rules only, stopping at the first that does not fit. */
const withinBudget = (ranking: readonly OwnerRule[]): Set<string> => {
  const whole = new Set<string>();
  let used = 0;
  for (const rule of ranking) {
    // A whole rule costs what an unjudged call sends: its text.
    const cost = ruleChars(deliverUnjudged(rule));
    if (used + cost > BUDGET_CHARS) break;
    used += cost;
    whole.add(rule.id);
  }
  return whole;
};

// Chronological, then by opaque id for a stable tie-break: neither is
// human-facing text, so no collator applies.
const promotedMs = (rule: OwnerRule) =>
  rule.promotedAt ? Date.parse(rule.promotedAt) : Number.NEGATIVE_INFINITY;
const newestFirst = [...rules].sort(
  (a, b) =>
    promotedMs(b) - promotedMs(a) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
);
const newestWhole = withinBudget(newestFirst);

const embedder = new E5SmallEmbeddingService();
const ruleVectors = await embedder.embed(
  rules.map((rule) => rule.applies_when ?? rule.text),
  'passage'
);
const topicVectors = await embedder.embed(topics, 'query');
const cosine = (a: readonly number[], b: readonly number[]): number => {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let at = 0; at < a.length; at += 1) {
    const x = a[at] ?? 0;
    const y = b[at] ?? 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  return na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb);
};
const cosineWhole = new Map(
  topics.map((topic, at) => {
    const query = topicVectors[at] ?? [];
    const scored = rules.map((rule, index) => ({
      rule,
      score: cosine(query, ruleVectors[index] ?? []),
    }));
    scored.sort((a, b) => b.score - a.score);
    return [topic, withinBudget(scored.map((entry) => entry.rule))] as const;
  })
);

interface JudgeRun {
  readonly judge: NamedJudge;
  readonly byTopic: ReadonlyMap<string, TopicJudgment | null>;
}

const judges = [typesafeJudge(), subqJudge()].filter(
  (judge): judge is NamedJudge => judge !== null
);
const judgeRuns: JudgeRun[] = [];
for (const judge of judges) {
  const byTopic = new Map<string, TopicJudgment | null>();
  for (const topic of topics) {
    byTopic.set(topic, await judgeTopic(judge, topic, rules, owner));
  }
  judgeRuns.push({ judge, byTopic });
}

/** The gate delivers whole: level full, an unanswered rule, or an unanswered topic. */
const judgedWhole = (run: JudgeRun, topic: string, ruleId: string): boolean => {
  const judged = run.byTopic.get(topic);
  const p = judged?.p.get(ruleId);
  return p === undefined || levelOf(p) === 'full';
};

const rankers: Array<{
  name: string;
  whole: (probe: Probe) => boolean;
}> = [
  { name: 'newest', whole: (probe) => newestWhole.has(probe.ruleId) },
  {
    name: 'cosine',
    whole: (probe) => cosineWhole.get(probe.topic)?.has(probe.ruleId) ?? false,
  },
  ...judgeRuns.map((run) => ({
    name: `${run.judge.provider} ${run.judge.model}`,
    whole: (probe: Probe) => judgedWhole(run, probe.topic, probe.ruleId),
  })),
];

// ── Scores ───────────────────────────────────────────────────────────────────

const ratio = (numerator: number, denominator: number): number | null =>
  denominator > 0 ? Number((numerator / denominator).toFixed(3)) : null;

const buckets: Array<ProbeType | 'overall'> = [
  ...PROBE_TYPES,
  ...(probes.some((probe) => probe.type === 'untyped')
    ? (['untyped'] as const)
    : []),
  'overall',
];

const scoreRows = rankers.flatMap((ranker) =>
  buckets.map((bucket) => {
    const inBucket = probes.filter(
      (probe) => bucket === 'overall' || probe.type === bucket
    );
    const full = inBucket.filter((probe) => probe.expect === 'full');
    const headline = inBucket.filter((probe) => probe.expect === 'headline');
    return {
      ranker: ranker.name,
      type: bucket,
      full_probes: full.length,
      hit_at_full: ratio(full.filter(ranker.whole).length, full.length),
      headline_probes: headline.length,
      false_full: ratio(headline.filter(ranker.whole).length, headline.length),
    };
  })
);

const judgeReports = judgeRuns.map((run) => {
  const answered = [...run.byTopic.values()].filter(
    (judged): judged is TopicJudgment => judged !== null
  );
  const bins = Array.from({ length: 10 }, (_, bin) => ({
    bin: `${(bin / 10).toFixed(1)}–${((bin + 1) / 10).toFixed(1)}`,
    probes: 0,
    pSum: 0,
    full: 0,
  }));
  let unanswered = 0;
  for (const probe of probes) {
    const p = run.byTopic.get(probe.topic)?.p.get(probe.ruleId);
    if (p === undefined) {
      unanswered += 1;
      continue;
    }
    // The epsilon keeps 0.3 in its own bin despite 0.3 * 10 = 2.999….
    const bin = bins[Math.min(9, Math.floor(p * 10 + 1e-9))];
    if (!bin) continue;
    bin.probes += 1;
    bin.pSum += p;
    if (probe.expect === 'full') bin.full += 1;
  }
  const tokens = answered.map((judged) => judged.inputTokens);
  return {
    provider: run.judge.provider,
    model: run.judge.model,
    calls: run.byTopic.size,
    unavailable_calls: run.byTopic.size - answered.length,
    probes_without_p: unanswered,
    wall_clock_latency_ms: {
      p50: percentile(
        answered.map((judged) => judged.latencyMs),
        50
      ),
      p95: percentile(
        answered.map((judged) => judged.latencyMs),
        95
      ),
    },
    // The provider reports usage per call; none reported reads as n/a.
    input_tokens_per_call: tokens.some((count) => count > 0)
      ? Math.round(
          tokens.reduce((sum, count) => sum + count, 0) / tokens.length
        )
      : null,
    calibration: bins
      .filter((bin) => bin.probes > 0)
      .map((bin) => ({
        bin: bin.bin,
        probes: bin.probes,
        mean_p: Number((bin.pSum / bin.probes).toFixed(3)),
        share_full: ratio(bin.full, bin.probes),
      })),
  };
});

// ── Report ───────────────────────────────────────────────────────────────────

const show = (value: number | null): string =>
  value === null ? 'n/a' : String(value);

const lines: string[] = [
  `## Rule gate evaluation — ${owner}`,
  '',
  "> Probe topics are the ledger's stored queries, cut to 200 characters; the gate judged the full text.",
  '> Each replay judges every live unpinned rule of the owner in one request — more than the merged ' +
    'general + project set a session receives — so latency and input tokens per call are an upper bound.',
  '',
  `${probes.length} probes over ${topics.length} topics, ${rules.length} unpinned rules; ` +
    `budget ${BUDGET_CHARS} characters (newest, cosine), bands ${bands.lo}/${bands.hi} (judge)` +
    (skippedDead > 0 ? `; ${skippedDead} probes skipped (rule not live)` : ''),
  '',
  '| ranker | type | full probes | hit@full | headline probes | false_full |',
  '| --- | --- | ---: | ---: | ---: | ---: |',
  ...scoreRows.map(
    (row) =>
      `| ${row.ranker} | ${row.type} | ${row.full_probes} | ${show(row.hit_at_full)} | ` +
      `${row.headline_probes} | ${show(row.false_full)} |`
  ),
];
for (const report of judgeReports) {
  lines.push(
    '',
    `### ${report.provider} ${report.model}`,
    '',
    `${report.calls} calls, ${report.unavailable_calls} unavailable; ` +
      `wall-clock latency around judge() p50 ${show(report.wall_clock_latency_ms.p50)} ms, ` +
      `p95 ${show(report.wall_clock_latency_ms.p95)} ms; ` +
      `input tokens per call ${
        report.input_tokens_per_call === null
          ? 'n/a (the provider reported no usage)'
          : report.input_tokens_per_call
      }` +
      (report.probes_without_p > 0
        ? `; ${report.probes_without_p} probes without a probability`
        : ''),
    '',
    '| p bin | probes | mean p | share expect=full |',
    '| --- | ---: | ---: | ---: |',
    ...report.calibration.map(
      (bin) =>
        `| ${bin.bin} | ${bin.probes} | ${bin.mean_p} | ${show(bin.share_full)} |`
    )
  );
}
console.log(lines.join('\n'));

const stamp = new Date().toISOString().replaceAll(':', '-');
const out = resolve(process.cwd(), `rule-gate-eval-${stamp}.json`);
writeFileSync(
  out,
  `${JSON.stringify(
    {
      owner,
      run_at: new Date().toISOString(),
      budget_chars: BUDGET_CHARS,
      bands: { hi: bands.hi, lo: bands.lo },
      probes: probes.length,
      topics: topics.length,
      rules: rules.length,
      skipped_dead: skippedDead,
      scores: scoreRows,
      judges: judgeReports,
      // Which ranker delivered each probe whole, and every judge's p for it:
      // what a reader needs to see WHY a rate moved.
      outcomes: probes.map((probe) => ({
        probe_id: probe.id,
        topic: probe.topic,
        rule_id: probe.ruleId,
        expect: probe.expect,
        type: probe.type,
        whole: Object.fromEntries(
          rankers.map((ranker) => [ranker.name, ranker.whole(probe)])
        ),
        p: Object.fromEntries(
          judgeRuns.map((run) => [
            `${run.judge.provider} ${run.judge.model}`,
            run.byTopic.get(probe.topic)?.p.get(probe.ruleId) ?? null,
          ])
        ),
      })),
    },
    null,
    2
  )}\n`
);
console.log(`\nrun written to ${out}`);
