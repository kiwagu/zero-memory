/**
 * How often the rule gate's judge agrees with a stronger model, and what the
 * gate costs in time, over the build_context calls it actually judged.
 *
 * Every call in the window that carries a `rule_gate` block counts toward the
 * judge-unavailable share (no sampling). The latency percentiles are the
 * adapter-reported `rule_gate.latency_ms` of the calls the judge answered; an
 * unavailable call logs 0 and is left out of them.
 *
 * A random `--sample` of the answered calls is then re-judged rule by rule by
 * the LLM gateway's model — the stored topic plus what the judge saw of the
 * rule (its headline with its condition, or its text when it has none) — and
 * its yes/no is compared with the gate's verdict: a rule the gate did not cut
 * to its headline counts as binding. Agreement is reported overall and per
 * level.
 *
 * Only calls whose stored topic reads as an agent's task statement (at least
 * 40 characters, with whitespace — the same test the probe draft applies) are
 * re-judged. A hook briefing is judged against its card's statement, which the
 * ledger does not store: its row holds the topic the hook passed, a project
 * folder name, so re-judging it would compare the gate with a different task.
 * Those calls, and agent calls with a short topic, are counted and excluded.
 * For the rest, the stored topic is the first 200 characters of what the
 * judge saw.
 *
 *   SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=… ANTHROPIC_API_KEY=… \
 *     bun run rules:gate-agreement -- --days 14 --sample 40 [--owner usr_…]   # from apps/server
 *
 * Point it at a stand (the e2e stack, or a production clone restored into the
 * preview stand), never at hosted production.
 */
import {
  entityIdSchemas,
  ruleGateBlockSchema,
  ruleHeadline,
  type RuleDeliveryLevel,
} from '@workspace/contracts';
import { container } from '@workspace/di';
import { llmGateway } from '@workspace/llm';
import { createServiceRoleClient, readAllPages } from '@workspace/persistence';
import { z } from 'zod';

import { register } from './registry/index.js';

// The re-judging goes through the LLM gateway, which only the composition
// root installs.
register(container);

const DEFAULT_MODEL = 'claude-sonnet-5';
const TOOL = 'record_binding';
const CONCURRENCY = 4;

const POLICY = `
You decide whether ONE standing rule binds a task an agent is about to work
on. The rule binds when the task, as described, has the features the rule's
condition names, so following the rule changes what the agent does during
this task. Judge only from the task description and the rule as given.`.trim();

const bindingSchema = z.object({ binds: z.boolean() });

const flag = (name: string): string | undefined => {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? undefined : process.argv[at + 1];
};

const countFlag = (name: string, fallback: number): number => {
  const raw = flag(name);
  const value = Number(raw ?? fallback);
  if (!Number.isInteger(value) || value <= 0) {
    console.error(`--${name} must be a positive integer (got ${String(raw)})`);
    process.exit(1);
  }
  return value;
};

const days = countFlag('days', 14);
const sampleSize = countFlag('sample', 40);
const owner = flag('owner');
if (owner !== undefined && !entityIdSchemas.user.is(owner)) {
  console.error(
    `--owner must be a user id (usr_<rand16>.<ts10>), got ${owner}`
  );
  process.exit(1);
}

const eventMetadataSchema = z.object({
  query: z.string().optional(),
  rule_gate: ruleGateBlockSchema,
});

/** Nearest-rank percentile; null for an empty sample. */
const percentile = (values: readonly number[], q: number): number | null => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(1, Math.ceil((q / 100) * sorted.length)) - 1] ?? null;
};

const client = createServiceRoleClient();
const since = new Date(Date.now() - days * 86_400_000).toISOString();

const rows = await readAllPages(
  (from, to) => {
    const query = client
      .from('usage_events')
      .select('id, user_id, metadata')
      .eq('event_type', 'mcp_tool_call')
      .not('metadata->rule_gate', 'is', null)
      .gte('occurred_at', since);
    return (owner ? query.eq('user_id', owner) : query)
      .order('id', { ascending: true })
      .range(from, to);
  },
  { label: 'gated call lookup' }
);

interface GatedCall {
  id: string;
  userId: string | null;
  query: string | null;
  gate: z.infer<typeof ruleGateBlockSchema>;
}

const calls: GatedCall[] = [];
let malformed = 0;
for (const row of rows) {
  const parsed = eventMetadataSchema.safeParse(row.metadata);
  if (!parsed.success) {
    malformed += 1;
    continue;
  }
  calls.push({
    id: row.id,
    userId: row.user_id,
    query: parsed.data.query ?? null,
    gate: parsed.data.rule_gate,
  });
}
if (calls.length === 0) {
  console.error(`no judged build_context calls in the last ${days} days`);
  process.exit(1);
}

const answered = calls.filter((call) => !call.gate.judge_unavailable);
const latencies = answered.map((call) => call.gate.latency_ms);

/**
 * A stored topic that reads as an agent's task statement — the probe draft's
 * test. A hook briefing's row holds the project folder name the hook passed
 * (no whitespace), not the card statement the gate judged.
 */
const MIN_TOPIC_CHARS = 40;
const isTaskTopic = (query: string | null): query is string => {
  const topic = query?.trim() ?? '';
  return topic.length >= MIN_TOPIC_CHARS && /\s/u.test(topic);
};

// Only answered calls with a task topic and at least one judged rule can be
// re-judged; shuffle them (Fisher–Yates) and take the sample.
const judgedSome = answered.filter((call) =>
  call.gate.rules.some((rule) => !rule.pinned && rule.p !== null)
);
const candidates = judgedSome.flatMap((call) =>
  isTaskTopic(call.query) ? [{ ...call, query: call.query }] : []
);
const excludedTopics = judgedSome.length - candidates.length;
for (let at = candidates.length - 1; at > 0; at -= 1) {
  const pick = Math.floor(Math.random() * (at + 1));
  [candidates[at], candidates[pick]] = [candidates[pick]!, candidates[at]!];
}
const sample = candidates.slice(0, sampleSize);

interface Comparison {
  level: RuleDeliveryLevel;
  gateBinds: boolean;
  llmBinds: boolean;
}

const ruleIds = [
  ...new Set(
    sample.flatMap((call) =>
      call.gate.rules
        .filter((rule) => !rule.pinned && rule.p !== null)
        .map((rule) => rule.id)
    )
  ),
];
const ruleRows =
  ruleIds.length === 0
    ? []
    : await readAllPages(
        (from, to) =>
          client
            .from('rule_candidates')
            .select('id, rule_text, applies_when')
            .in('id', ruleIds)
            .order('id', { ascending: true })
            .range(from, to),
        { label: 'rule lookup' }
      );
const ruleById = new Map(
  ruleRows.flatMap((row) => {
    const text = row.rule_text?.trim();
    return text
      ? [[row.id, { text, appliesWhen: row.applies_when }] as const]
      : [];
  })
);

const model = process.env.ZM_HYGIENE_MODEL ?? DEFAULT_MODEL;
const jobs = sample.flatMap((call) =>
  call.gate.rules
    .filter((rule) => !rule.pinned && rule.p !== null)
    .map((rule) => ({ call, rule }))
);
const comparisons: Comparison[] = [];
let missingRules = 0;

const runJob = async ({ call, rule }: (typeof jobs)[number]): Promise<void> => {
  const stored = ruleById.get(rule.id);
  if (!stored) {
    missingRules += 1;
    return;
  }
  // What the judge saw of the rule: the headline with its condition, or its
  // text when it has none.
  const ruleBlock = stored.appliesWhen
    ? `${ruleHeadline(stored.text)}\nApplies when: ${stored.appliesWhen}`
    : stored.text;
  const response = await llmGateway().callTool({
    model,
    maxOutputTokens: 300,
    system: POLICY,
    prompt: `Task:\n${call.query}\n\nRule:\n${ruleBlock}`,
    tool: {
      name: TOOL,
      description: 'Record whether the rule binds the task.',
      inputSchema: z.toJSONSchema(bindingSchema, {
        target: 'draft-7',
      }) as Record<string, unknown>,
    },
    purpose: 'rule_distiller',
    ...(call.userId ? { subjectId: call.userId } : {}),
  });
  comparisons.push({
    level: rule.level,
    gateBinds: rule.level !== 'headline',
    llmBinds: bindingSchema.parse(response.input).binds,
  });
};

let next = 0;
await Promise.all(
  Array.from({ length: Math.min(CONCURRENCY, jobs.length) }, async () => {
    while (next < jobs.length) {
      const job = jobs[next];
      next += 1;
      if (job) await runJob(job);
    }
  })
);

const ratio = (numerator: number, denominator: number): string =>
  denominator > 0 ? (numerator / denominator).toFixed(3) : 'n/a';
const agreeing = (list: readonly Comparison[]) =>
  list.filter((entry) => entry.gateBinds === entry.llmBinds).length;
const show = (value: number | null): string =>
  value === null ? 'n/a' : String(value);

const levels: RuleDeliveryLevel[] = ['full', 'gate', 'headline'];
const unavailable = calls.length - answered.length;
console.log(
  [
    `## Rule gate agreement — last ${days} days${owner ? `, ${owner}` : ''}`,
    '',
    `${calls.length} judged calls` +
      (malformed > 0 ? ` (${malformed} unreadable blocks skipped)` : '') +
      `; judge unavailable on ${unavailable} (${ratio(unavailable, calls.length)}).`,
    `Adapter-reported latency (rule_gate.latency_ms) over ${answered.length} answered calls: ` +
      `p50 ${show(percentile(latencies, 50))} ms, p95 ${show(percentile(latencies, 95))} ms ` +
      `(${unavailable} unavailable calls log 0 and are left out).`,
    '',
    `${excludedTopics} calls excluded: hook briefings judged against an unstored card ` +
      `statement, or topics under ${MIN_TOPIC_CHARS} characters.`,
    `Re-judged ${sample.length} sampled calls, ${comparisons.length} rules, with ${model}` +
      (missingRules > 0 ? ` (${missingRules} rules no longer stored)` : '') +
      '.',
    '',
    '| level | rules | gate binds | model binds | agreement |',
    '| --- | ---: | ---: | ---: | ---: |',
    ...[...levels, 'overall' as const].map((level) => {
      const list =
        level === 'overall'
          ? comparisons
          : comparisons.filter((entry) => entry.level === level);
      return (
        `| ${level} | ${list.length} | ${list.filter((entry) => entry.gateBinds).length} | ` +
        `${list.filter((entry) => entry.llmBinds).length} | ${ratio(agreeing(list), list.length)} |`
      );
    }),
  ].join('\n')
);
