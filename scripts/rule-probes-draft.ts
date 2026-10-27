/**
 * Drafts the rule-gate probe set from what an owner's agents actually briefed
 * on, for the owner to confirm by hand — then imports the confirmed rows.
 *
 * Draft: the owner's last `--max` distinct build_context topics (at least 40
 * characters, and not a bare project folder name) are each judged once
 * against the owner's unpinned rules, as the gate judges them. A rule the
 * judge puts at or above the upper band is proposed as `full`, one below the
 * lower band as `headline`; the uncertain middle is left out. The proposals
 * land in `rule-probes-draft.csv` in the current directory.
 *
 *   SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=… ZM_TYPESAFE_API_KEY=… \
 *     bun scripts/rule-probes-draft.ts --owner usr_… --max 60
 *
 * Confirm: in the CSV, correct `proposed_expect` where the judge is wrong,
 * fill `type` with `trigger` or `trajectory`, and set `confirm` to `y` for
 * every row to keep. Then:
 *
 *   SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=… \
 *     bun scripts/rule-probes-draft.ts --owner usr_… --import rule-probes-draft.csv
 *
 * inserts the confirmed rows into `rule_probes` (`note` = the type). A row
 * already live for the same topic and rule is skipped, so a re-import is safe.
 *
 * Point it at a stand (the e2e stack, or a production clone restored into the
 * preview stand), never at hosted production.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  entityIdSchemas,
  ruleHeadline,
} from '../packages/contracts/src/index.js';
import { readAllPages } from '../packages/persistence/src/paged-read.js';

import {
  countFlag,
  fail,
  flag,
  gateConfig,
  judgeTopic,
  levelOf,
  loadJudgeableRules,
  ownerFlag,
  parseCsv,
  standClient,
  toCsv,
  typesafeJudge,
  type StandClient,
} from './rule-gate.utils.js';

const DRAFT_FILE = 'rule-probes-draft.csv';
const HEADER = [
  'topic',
  'rule_id',
  'rule_headline',
  'p',
  'proposed_expect',
  'type',
  'confirm',
] as const;
const MIN_TOPIC_CHARS = 40;
const PAGE_SIZE = 500;
const PROBE_TYPES = new Set(['trigger', 'trajectory']);
const EXPECTS = new Set(['full', 'headline']);

const owner = ownerFlag();
const client = standClient();
const importPath = flag('import');
if (process.argv.includes('--import') && !importPath) {
  fail('--import needs the path of the confirmed CSV');
}

/**
 * The owner's newest distinct build_context topics, newest first. A topic
 * with no whitespace is a project folder name a hook passed, not a task.
 */
const recentTopics = async (
  stand: StandClient,
  max: number
): Promise<string[]> => {
  const topics: string[] = [];
  const seen = new Set<string>();
  for (let offset = 0; topics.length < max;) {
    const { data, error } = await stand
      .from('usage_events')
      .select('id, occurred_at, query:metadata->>query')
      .eq('event_type', 'mcp_tool_call')
      .eq('user_id', owner)
      .eq('metadata->>tool', 'build_context')
      .not('metadata->>query', 'is', null)
      .order('occurred_at', { ascending: false })
      .order('id', { ascending: true })
      .range(offset, offset + PAGE_SIZE - 1);
    if (error) {
      throw new Error(`topic lookup failed: ${error.message}`);
    }
    const batch = data ?? [];
    if (batch.length === 0) break;
    // Advance by what arrived: a server cap below the page size must not
    // skip rows.
    offset += batch.length;
    for (const row of batch) {
      const topic = typeof row.query === 'string' ? row.query.trim() : '';
      if (topic.length < MIN_TOPIC_CHARS || !/\s/u.test(topic)) continue;
      if (seen.has(topic)) continue;
      seen.add(topic);
      topics.push(topic);
      if (topics.length === max) break;
    }
  }
  return topics;
};

const draft = async (): Promise<void> => {
  const max = countFlag('max', 60);
  const judge = typesafeJudge();
  const bands = gateConfig();
  const rules = await loadJudgeableRules(client, owner);
  if (rules.length === 0) {
    fail(`no unpinned promoted rules for ${owner}`);
  }
  const topics = await recentTopics(client, max);
  if (topics.length === 0) {
    fail(`no build_context topics for ${owner}`);
  }

  const rows: string[][] = [[...HEADER]];
  let unavailable = 0;
  for (const topic of topics) {
    const judged = await judgeTopic(judge, topic, rules, owner);
    if (!judged) {
      unavailable += 1;
      continue;
    }
    for (const rule of rules) {
      const p = judged.p.get(rule.id);
      if (p === undefined) continue;
      // The gate's own levels: `full` and `headline` are confident; `gate`
      // is the uncertain middle and is left out.
      const proposed = levelOf(p);
      if (proposed === 'gate') continue;
      rows.push([
        topic,
        rule.id,
        ruleHeadline(rule.text),
        p.toFixed(3),
        proposed,
        '',
        '',
      ]);
    }
  }
  const out = resolve(process.cwd(), DRAFT_FILE);
  writeFileSync(out, toCsv(rows));
  console.log(
    `${rows.length - 1} probe rows drafted from ${topics.length} topics × ${rules.length} rules ` +
      `(${judge.provider} ${judge.model}, bands ${bands.lo}/${bands.hi}` +
      `${unavailable > 0 ? `, ${unavailable} topics unanswered` : ''}) → ${out}`
  );
  console.log(
    'Fill `type` (trigger|trajectory), correct `proposed_expect` where needed, ' +
      'set `confirm` to y, then rerun with --import.'
  );
};

interface ConfirmedProbe {
  topic: string;
  rule_id: string;
  expect: 'full' | 'headline';
  note: string;
}

const importConfirmed = async (path: string): Promise<void> => {
  const [header, ...body] = parseCsv(readFileSync(resolve(path), 'utf8'));
  const columns = new Map((header ?? []).map((name, at) => [name.trim(), at]));
  const missing = HEADER.filter((name) => !columns.has(name));
  if (missing.length > 0) {
    fail(`${path}: missing columns ${missing.join(', ')}`);
  }
  const cell = (row: readonly string[], name: (typeof HEADER)[number]) =>
    (row[columns.get(name) ?? -1] ?? '').trim();

  const live = new Set(
    (await loadJudgeableRules(client, owner)).map((r) => r.id)
  );
  const confirmed: ConfirmedProbe[] = [];
  const problems: string[] = [];
  body.forEach((row, at) => {
    if (cell(row, 'confirm').toLowerCase() !== 'y') return;
    const line = at + 2;
    const ruleId = cell(row, 'rule_id');
    const expect = cell(row, 'proposed_expect');
    const type = cell(row, 'type').toLowerCase();
    const topic = cell(row, 'topic');
    if (!topic) problems.push(`line ${line}: empty topic`);
    if (!entityIdSchemas.rule_candidate.is(ruleId) || !live.has(ruleId)) {
      problems.push(
        `line ${line}: ${ruleId} is not a live unpinned rule of ${owner}`
      );
    }
    if (!EXPECTS.has(expect)) {
      problems.push(
        `line ${line}: proposed_expect must be full or headline, got "${expect}"`
      );
    }
    if (!PROBE_TYPES.has(type)) {
      problems.push(
        `line ${line}: type must be trigger or trajectory, got "${type}"`
      );
    }
    confirmed.push({
      topic,
      rule_id: ruleId,
      expect: expect as ConfirmedProbe['expect'],
      note: type,
    });
  });
  if (problems.length > 0) {
    fail(`nothing imported — fix these rows first:\n${problems.join('\n')}`);
  }

  const existing = await readAllPages(
    (from, to) =>
      client
        .from('rule_probes')
        .select('id, topic, rule_id')
        .eq('owner_id', owner)
        .is('retired_at', null)
        .order('id', { ascending: true })
        .range(from, to),
    { label: 'probe lookup' }
  );
  const key = (probe: { topic: string; rule_id: string }) =>
    `${probe.rule_id}\u0000${probe.topic}`;
  const present = new Set(existing.map(key));
  const fresh = confirmed.filter((probe) => {
    if (present.has(key(probe))) return false;
    present.add(key(probe));
    return true;
  });
  if (fresh.length > 0) {
    const { error } = await client
      .from('rule_probes')
      .insert(fresh.map((probe) => ({ ...probe, owner_id: owner })));
    if (error) {
      throw new Error(`probe insert failed: ${error.message}`);
    }
  }
  console.log(
    `${fresh.length} probes imported for ${owner} ` +
      `(${confirmed.length} confirmed, ${confirmed.length - fresh.length} already live)`
  );
};

if (importPath !== undefined) {
  await importConfirmed(importPath);
} else {
  await draft();
}
