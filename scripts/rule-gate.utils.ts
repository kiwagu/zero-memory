/**
 * What the rule-gate measurement scripts share: the stand connection, the
 * owner's judgeable rules, and one judgment over a task asked exactly the way
 * the gate asks it (`ruleGateRequest`, the same builder the service uses).
 *
 * Package source is imported by relative path: these scripts live at the repo
 * root, which does not depend on the workspace packages, so the bare
 * specifiers do not resolve from here (see search-eval.ts).
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import { entityIdSchemas } from '../packages/contracts/src/index.js';
import type { Database } from '../packages/db/src/index.js';
import {
  JudgeUnavailableError,
  readJudgeConfig,
  readRuleGateConfig,
  SubqJudgment,
  TypeSafeJudgment,
  type IJudgment,
  type JudgeProviderName,
} from '../packages/judgment/src/index.js';
import {
  levelFor,
  ruleGateRequest,
  type JudgedRule,
} from '../packages/memory/src/rule-gate.service.js';
import { readAllPages } from '../packages/persistence/src/paged-read.js';
import { toContextRule } from '../packages/persistence/src/rules/promoted-rule.utils.js';

export type StandClient = SupabaseClient<Database>;

/** The value after `--<name>`, or undefined when the flag is absent. */
export const flag = (name: string): string | undefined => {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? undefined : process.argv[at + 1];
};

/** Prints the problem and stops: a bad flag is the operator's to fix. */
export const fail = (message: string): never => {
  console.error(message);
  process.exit(1);
};

/** `--owner`, required and well-formed. */
export const ownerFlag = (): string => {
  const owner = flag('owner');
  if (!owner || !entityIdSchemas.user.is(owner)) {
    return fail(
      `--owner must be a user id (usr_<rand16>.<ts10>), got ${String(owner)}`
    );
  }
  return owner;
};

/** A positive integer flag with a default. */
export const countFlag = (name: string, fallback: number): number => {
  const raw = flag(name);
  const value = Number(raw ?? fallback);
  if (!Number.isInteger(value) || value <= 0) {
    return fail(`--${name} must be a positive integer (got ${String(raw)})`);
  }
  return value;
};

const requiredEnv = (name: string): string => {
  const value = process.env[name];
  if (!value) {
    return fail(`${name} must be set`);
  }
  return value;
};

/**
 * Service-role client on the stand the environment names (the e2e stack, or
 * a production clone restored into the preview stand — never hosted
 * production): every owner's rows, RLS bypassed.
 */
export const standClient = (): StandClient =>
  createClient<Database>(
    requiredEnv('SUPABASE_URL'),
    requiredEnv('SUPABASE_SERVICE_ROLE_KEY'),
    { auth: { persistSession: false, autoRefreshToken: false } }
  );

/** A rule the gate judges, with what the rankings that preceded it read. */
export interface OwnerRule extends JudgedRule {
  readonly promotedAt: string | null;
}

/**
 * The owner's live promoted rules the gate would judge: unpinned (a pinned
 * rule is never judged), either layer, shaped exactly as delivery shapes them.
 */
export const loadJudgeableRules = async (
  client: StandClient,
  owner: string
): Promise<OwnerRule[]> => {
  const rows = await readAllPages(
    (from, to) =>
      client
        .from('rule_candidates')
        .select(
          'id, rule_text, applies_when, promoted_at, memories!inner(owner_id)'
        )
        .eq('status', 'promoted')
        .eq('pinned', false)
        .is('revoked_at', null)
        .not('rule_text', 'is', null)
        .eq('memories.owner_id', owner)
        .order('id', { ascending: true })
        .range(from, to),
    { label: 'owner rules lookup' }
  );
  return rows.flatMap((row): OwnerRule[] => {
    const text = row.rule_text?.trim() ?? '';
    if (!text) return [];
    return [
      {
        ...toContextRule({
          id: row.id,
          text,
          pinned: false,
          appliesWhen: row.applies_when,
        }),
        id: row.id,
        promotedAt: row.promoted_at,
      },
    ];
  });
};

/** The judge's bands and per-request timeout, from the gate's own env knobs. */
export const gateConfig = () => readRuleGateConfig(process.env);

export interface NamedJudge {
  readonly provider: JudgeProviderName;
  readonly model: string;
  readonly judgment: IJudgment;
}

/** TypeSafe on the platform key; required — the scripts call no other provider in its place. */
export const typesafeJudge = (): NamedJudge => {
  const config = readJudgeConfig(process.env);
  const apiKey = config.platformKeys.typesafe;
  if (!apiKey) {
    return fail('ZM_TYPESAFE_API_KEY must be set');
  }
  const model = config.models.typesafe;
  return {
    provider: 'typesafe',
    model,
    judgment: new TypeSafeJudgment({ apiKey, model }),
  };
};

/** SubQ Snap, only when its key is set. */
export const subqJudge = (): NamedJudge | null => {
  const config = readJudgeConfig(process.env);
  const apiKey = config.platformKeys.subq;
  if (!apiKey) return null;
  const model = config.models.subq;
  return {
    provider: 'subq',
    model,
    judgment: new SubqJudgment({ apiKey, model }),
  };
};

export interface TopicJudgment {
  /** Probability per rule id; absent when the judge left a rule unanswered. */
  readonly p: ReadonlyMap<string, number>;
  /** Wall-clock time around the call, as the gate's caller waits for it. */
  readonly latencyMs: number;
  /** As the provider reported them; 0 when it reported no usage. */
  readonly inputTokens: number;
}

/**
 * One judgment of every rule against one task, as the gate asks it. Null when
 * the judge was unavailable (timeout, 429, 5xx) — the gate then delivers every
 * rule whole. Any other failure is a broken request and stops the run.
 */
export const judgeTopic = async (
  judge: NamedJudge,
  task: string,
  rules: readonly JudgedRule[],
  owner: string
): Promise<TopicJudgment | null> => {
  const { state, questions } = ruleGateRequest(task, rules);
  const started = performance.now();
  try {
    const result = await judge.judgment.judge(
      { state, questions, purpose: 'rule_gate', subjectId: owner },
      { timeoutMs: gateConfig().timeoutMs }
    );
    const latencyMs = Math.round(performance.now() - started);
    const p = new Map<string, number>();
    for (const rule of rules) {
      const answer = result.answers[`rule_${rule.id}`];
      if (answer) p.set(rule.id, answer.noul);
    }
    return { p, latencyMs, inputTokens: result.usage.inputTokens };
  } catch (error) {
    if (error instanceof JudgeUnavailableError) {
      console.error(
        `${judge.provider}: unavailable for one topic (${error.message})`
      );
      return null;
    }
    throw error;
  }
};

/** The level the gate gives a probability, under the configured bands. */
export const levelOf = (p: number) => levelFor(p, gateConfig());

/** Nearest-rank percentile; null for an empty sample. */
export const percentile = (
  values: readonly number[],
  q: number
): number | null => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil((q / 100) * sorted.length));
  return sorted[rank - 1] ?? null;
};

/** RFC 4180 field: quoted when it carries a comma, a quote or a line break. */
const csvField = (value: string): string =>
  /[",\r\n]/u.test(value) ? `"${value.replaceAll('"', '""')}"` : value;

export const toCsv = (rows: readonly (readonly string[])[]): string =>
  rows.map((row) => row.map(csvField).join(',')).join('\r\n') + '\r\n';

/** RFC 4180 parse: quoted fields may hold commas, doubled quotes and line breaks. */
export const parseCsv = (text: string): string[][] => {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let at = 0; at < text.length; at += 1) {
    const char = text[at];
    if (quoted) {
      if (char === '"' && text[at + 1] === '"') {
        field += '"';
        at += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[at + 1] === '\n') at += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += char;
    }
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((cells) => cells.some((cell) => cell.trim() !== ''));
};
