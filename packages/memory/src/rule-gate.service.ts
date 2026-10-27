import {
  type BriefingWork,
  type ContextRule,
  type RuleDeliveryLevel,
  type RuleGateBlock,
  ruleHeadline,
} from '@workspace/contracts';
import { singleton } from '@workspace/di';
import {
  injectJudgeCredentialResolver,
  injectJudgeSettingsReader,
  injectJudgmentFactory,
  JudgeUnavailableError,
  type IJudgeCredentialResolver,
  type IJudgeSettingsReader,
  type JudgmentFactory,
  type JudgmentRequest,
  type JudgmentResult,
  type NoulQuestion,
  type RuleGateConfig,
} from '@workspace/judgment';
import { createLogger } from '@workspace/logger';
import {
  injectUsageRecorder,
  recordUsage,
  type IUsageRecorder,
} from '@workspace/usage';

import { injectRuleGateConfig } from './rule-gate.provider.js';

export interface RuleGateInput {
  readonly rules: ContextRule[];
  readonly subjectId: string;
  /**
   * What the rules are judged against: the agent's own English `topic` for an
   * agent call, or the statement built from the conversation's card for a
   * budgeted hook briefing (`hookTaskStatement`). Null means there is nothing
   * honest to judge against — a hook briefing with no card — and the rules
   * are delivered as before.
   */
  readonly task: string | null;
}

/**
 * The task statement of a hook briefing, from what the server already knows
 * about the conversation: the card bound to it, else the continuation card
 * offered to a new session. Nothing about the user's prompt is involved.
 */
export const hookTaskStatement = (
  work: BriefingWork | null | undefined
): string | null => {
  const card = work?.bound_card ?? work?.continuation?.card ?? null;
  if (!card) return null;
  const branch = work?.open_branches?.find(
    (entry) => entry.card_id === card.id
  )?.branch;
  return [
    `Continue card #${card.number} (${card.type ?? 'work'}, ${card.state}): ${card.title}.`,
    card.state_reason ? `Status: ${card.state_reason}` : null,
    branch ? `Branch: ${branch}.` : null,
  ]
    .filter((part): part is string => part !== null)
    .join(' ');
};

export interface RuleGateOutcome {
  readonly rules: ContextRule[];
  readonly block: RuleGateBlock | null;
}

export interface IRuleGate {
  apply(input: RuleGateInput): Promise<RuleGateOutcome>;
}

export const levelFor = (
  p: number,
  bands: { readonly hi: number; readonly lo: number }
): RuleDeliveryLevel =>
  p >= bands.hi ? 'full' : p >= bands.lo ? 'gate' : 'headline';

/** The rule as a session receives it at that level. The name always survives. */
export const deliverAtLevel = (
  rule: ContextRule,
  level: RuleDeliveryLevel
): ContextRule => {
  const headline = rule.headline ?? ruleHeadline(rule.text);
  if (level === 'full') return { ...rule, headline, level };
  if (level === 'gate') return { ...rule, headline, text: headline, level };
  const { applies_when: _dropped, ...named } = rule;
  return { ...named, headline, text: headline, level };
};

/** What a rule costs the session as delivered: its text and its condition. */
export const ruleChars = (rule: ContextRule): number =>
  rule.text.length + (rule.applies_when?.length ?? 0);

/** One rule's yes/no question. Exported so an evaluation can ask the same. */
export const questionFor = (key: string): NoulQuestion => ({
  kind: 'noul',
  instructions:
    `The agent is about to work on the task described in \`task\`. The standing rule \`rules.${key}\` ` +
    'binds a task when the condition in its `applies_when` holds for that task (when `applies_when` is ' +
    'missing, judge from `text`). Does this rule bind this task?',
  criteria: {
    true: 'The task, as described, has the features the rule names, so following the rule changes what the agent does during this task.',
    false:
      'The task does not have those features; the rule is about other kinds of work.',
  },
});

/** A rule the gate can judge: unpinned, and with an id to key its answer by. */
export type JudgedRule = ContextRule & { readonly id: string };

/**
 * The one judgment the gate asks per call: the task, and per rule its
 * headline with its condition (or its whole text when it has none), plus one
 * yes/no question keyed `rule_<id>`. Exported so an evaluation asks exactly
 * what the gate asks.
 */
export const ruleGateRequest = (
  task: string,
  rules: readonly JudgedRule[]
): Pick<JudgmentRequest, 'state' | 'questions'> => ({
  state: {
    task,
    rules: Object.fromEntries(
      rules.map((rule) => [
        rule.id,
        rule.applies_when
          ? {
              headline: rule.headline ?? ruleHeadline(rule.text),
              applies_when: rule.applies_when,
            }
          : {
              headline: rule.headline ?? ruleHeadline(rule.text),
              text: rule.text,
            },
      ])
    ),
  },
  questions: Object.fromEntries(
    rules.map((rule) => [`rule_${rule.id}`, questionFor(rule.id)])
  ),
});

const logger = createLogger('rule-gate');

/**
 * Decides, per call, how much of each unpinned standing rule the agent gets:
 * one yes/no question per rule to a decision model, answered as a probability,
 * mapped to full / gate / headline by two bands. Pinned rules are never judged.
 * `shadow` records what it would have done and delivers everything whole;
 * `live` delivers by level. Any judge failure delivers exactly as before and
 * says so — there is no second provider to fall back to.
 */
@singleton()
export class RuleGateService implements IRuleGate {
  constructor(
    @injectJudgeSettingsReader()
    private readonly settings: IJudgeSettingsReader,
    @injectJudgeCredentialResolver()
    private readonly credentials: IJudgeCredentialResolver,
    @injectJudgmentFactory()
    private readonly judgmentFor: JudgmentFactory,
    @injectUsageRecorder()
    private readonly usage: IUsageRecorder,
    @injectRuleGateConfig()
    private readonly config: RuleGateConfig
  ) {}

  async apply(input: RuleGateInput): Promise<RuleGateOutcome> {
    const unchanged: RuleGateOutcome = { rules: input.rules, block: null };
    const mode = this.config.mode;
    if (mode === 'off' || input.task === null) return unchanged;
    const unpinned = input.rules.filter(
      (rule): rule is JudgedRule => !rule.pinned && Boolean(rule.id)
    );
    if (unpinned.length === 0) return unchanged;
    const settings = await this.settings.read(input.subjectId);
    if (!settings.enabled) return unchanged;
    const credential = await this.credentials.resolve(
      input.subjectId,
      settings.provider ?? undefined
    );
    if (!credential) return unchanged;

    const { state, questions } = ruleGateRequest(input.task, unpinned);

    let result: JudgmentResult | null = null;
    try {
      result = await this.judgmentFor(credential).judge(
        { state, questions, purpose: 'rule_gate', subjectId: input.subjectId },
        { timeoutMs: this.config.timeoutMs }
      );
    } catch (error) {
      logger.warn(
        error instanceof JudgeUnavailableError
          ? 'judge unavailable; rules delivered whole'
          : 'judge failed; rules delivered whole',
        { error: error instanceof Error ? error.message : String(error) }
      );
    }
    // Metered only once a judgment came back: a failed call spent nothing
    // the provider reported.
    if (result) {
      recordUsage(this.usage, {
        eventType: 'llm_extraction',
        quantity: result.usage.inputTokens,
        unit: 'tokens',
        subjectId: input.subjectId,
        metadata: {
          purpose: 'rule_gate',
          provider: result.provider,
          model: result.model,
          owned_by_caller: credential.ownedByCaller,
          output_tokens: result.usage.outputTokens,
        },
      });
    }
    const judgeUnavailable = result === null;
    const answers = result?.answers ?? {};

    const levelled = input.rules.map((rule) => {
      if (rule.pinned || !rule.id) {
        return { rule: deliverAtLevel(rule, 'full'), p: null as number | null };
      }
      const p = judgeUnavailable
        ? null
        : (answers[`rule_${rule.id}`]?.noul ?? null);
      return {
        rule: deliverAtLevel(
          rule,
          p === null ? 'full' : levelFor(p, this.config)
        ),
        p,
      };
    });
    // Pinned first, then by probability (unanswered rules sit with the full ones).
    const ordered = [...levelled].sort(
      (a, b) =>
        Number(b.rule.pinned) - Number(a.rule.pinned) || (b.p ?? 1) - (a.p ?? 1)
    );
    // Shadow mode and a failed judge both hand the session the rules exactly
    // as they arrived; the block still says what happened.
    const asBefore = mode === 'shadow' || judgeUnavailable;
    const baseline = input.rules.reduce(
      (sum, rule) => sum + ruleChars(rule),
      0
    );
    const delivered = ordered.reduce(
      (sum, entry) => sum + ruleChars(entry.rule),
      0
    );
    const counts = { full: 0, gate: 0, headline: 0 };
    for (const entry of ordered) counts[entry.rule.level ?? 'full'] += 1;

    const block: RuleGateBlock = {
      mode,
      provider: credential.provider,
      model: result?.model ?? credential.model,
      latency_ms: result?.latencyMs ?? 0,
      judge_unavailable: judgeUnavailable,
      bands: { hi: this.config.hi, lo: this.config.lo },
      chars_baseline: baseline,
      chars_delivered: asBefore ? baseline : delivered,
      levels: counts,
      // A rule without an id cannot be named here; it is counted above and
      // delivered whole.
      rules: ordered.flatMap((entry) =>
        entry.rule.id
          ? [
              {
                id: entry.rule.id,
                p: entry.p,
                level: entry.rule.level ?? 'full',
                chars: ruleChars(entry.rule),
                pinned: entry.rule.pinned,
              },
            ]
          : []
      ),
    };
    if (asBefore) return { rules: input.rules, block };
    return { rules: ordered.map((entry) => entry.rule), block };
  }
}
