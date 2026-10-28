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
  JudgeRequestError,
  JudgeUnavailableError,
  type IJudgeCredentialResolver,
  type IJudgeSettingsReader,
  type JudgeProviderName,
  type JudgeSettings,
  type JudgmentFactory,
  type JudgmentRequest,
  type JudgmentResult,
  type NoulQuestion,
  type ResolvedJudgeCredential,
  type RuleGateConfig,
} from '@workspace/judgment';
import { createLogger } from '@workspace/logger';
import { injectBudgetGuard, type BudgetGuard } from '@workspace/policy';
import {
  injectUsageRecorder,
  recordUsage,
  type IUsageRecorder,
} from '@workspace/usage';

import type { CardTaskDetail } from './briefing-work.reader.js';
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
  /**
   * More of a hook briefing's task, read only once the account's judge is
   * on: the card's body and its latest steps (`hookTaskDetail`), joined to
   * `task`. A detail that cannot be read leaves `task` as it is.
   */
  readonly taskDetail?: () => Promise<string | null>;
}

/**
 * The card a hook briefing is judged against: the one bound to the
 * conversation, else the continuation card offered to a new session.
 */
export const hookTaskCard = (work: BriefingWork | null | undefined) =>
  work?.bound_card ?? work?.continuation?.card ?? null;

/**
 * The task statement of a hook briefing, from what the server already knows
 * about the conversation: the card bound to it, else the continuation card
 * offered to a new session. Nothing about the user's prompt is involved.
 */
export const hookTaskStatement = (
  work: BriefingWork | null | undefined
): string | null => {
  const card = hookTaskCard(work);
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

/** How much of one step the judge reads: its opening carries what was done. */
const STEP_CHARS = 400;

const clipStep = (said: string): string => {
  const line = said.replace(/\s+/gu, ' ').trim();
  return line.length > STEP_CHARS ? `${line.slice(0, STEP_CHARS - 1)}…` : line;
};

/**
 * The rest of a hook briefing's task: the card's body as written, then its
 * latest steps newest first, each on one clipped line. The body goes whole:
 * it is what the card is about, and its length costs the judge no time. Null
 * when the card has neither, so the statement is judged as it is.
 */
export const hookTaskDetail = (card: CardTaskDetail): string | null => {
  const body = card.body.trim();
  const steps = card.last.map(clipStep).filter((step) => step.length > 0);
  const parts = [
    body ? `Card: ${body}` : null,
    steps.length > 0
      ? `Latest steps: ${steps.map((step, index) => `(${index + 1}) ${step}`).join(' ')}`
      : null,
  ].filter((part): part is string => part !== null);
  return parts.length > 0 ? parts.join(' ') : null;
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

/**
 * A rule as a session receives it when nothing judged it: its whole text, its
 * pin and its id. Its condition of application is for the judge, so the
 * agent is not sent it.
 */
export const deliverUnjudged = (rule: ContextRule): ContextRule => ({
  text: rule.text,
  pinned: rule.pinned,
  ...(rule.id ? { id: rule.id } : {}),
});

/**
 * The rule as a session receives it at that level: the whole text at `full`,
 * the headline otherwise, and the condition of application only at `gate`,
 * the one level whose line shows it. The name always survives.
 */
export const deliverAtLevel = (
  rule: ContextRule,
  level: RuleDeliveryLevel
): ContextRule => {
  const named = deliverUnjudged(rule);
  if (level === 'full') return { ...named, level };
  const text = ruleHeadline(rule.text);
  if (level === 'gate' && rule.applies_when) {
    return { ...named, text, applies_when: rule.applies_when, level };
  }
  return { ...named, text, level };
};

/** What a delivered rule costs the session: its text and, if sent, its condition. */
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

/** A rule the gate can judge: unpinned, and with an id to map its answer to. */
export type JudgedRule = ContextRule & { readonly id: string };

/** One judgment's request, and which rule each of its questions is about. */
export interface RuleGateRequest extends Pick<
  JudgmentRequest,
  'state' | 'questions'
> {
  /** Question name (`r1`, `r2`, …) → the id of the rule it asks about. */
  readonly ids: Readonly<Record<string, string>>;
}

/**
 * The one judgment the gate asks per call: the task, and per rule its
 * headline with its condition (or its whole text when it has none), plus one
 * yes/no question. A rule is named by its position — `r1`, `r2`, … in the
 * order given — both as its question and as its key under `state.rules`: an
 * instruction points at the rule by a state path, and a rule id has a dot in
 * it, which a path would read as one more step. `ids` maps each name back.
 * At most 24 questions: the delivery caps admit 12 unpinned rules per layer,
 * and pinned rules are never asked about. Exported so an evaluation asks
 * exactly what the gate asks.
 */
export const ruleGateRequest = (
  task: string,
  rules: readonly JudgedRule[]
): RuleGateRequest => {
  const named = rules.map((rule, index) => ({ name: `r${index + 1}`, rule }));
  return {
    state: {
      task,
      rules: Object.fromEntries(
        named.map(({ name, rule }) => [
          name,
          rule.applies_when
            ? {
                headline: ruleHeadline(rule.text),
                applies_when: rule.applies_when,
              }
            : { headline: ruleHeadline(rule.text), text: rule.text },
        ])
      ),
    },
    questions: Object.fromEntries(
      named.map(({ name }) => [name, questionFor(name)])
    ),
    ids: Object.fromEntries(named.map(({ name, rule }) => [name, rule.id])),
  };
};

const logger = createLogger('rule-gate');

/** Why a call the gate set out to judge got no answer. */
type UnavailableReason = NonNullable<RuleGateBlock['unavailable_reason']>;

/** What one attempt to judge a call came to, answered or not. */
interface JudgeAttempt {
  readonly provider: JudgeProviderName;
  readonly model: string;
  /** Null when no answer came back. */
  readonly result: JudgmentResult | null;
  /** Question name → rule id, when the question was asked. */
  readonly ids: Readonly<Record<string, string>>;
  /** Absent for an answer, and for a judge that simply did not answer. */
  readonly reason?: UnavailableReason;
}

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * Decides, per call, how much of each unpinned standing rule the agent gets:
 * one yes/no question per rule to a decision model, answered as a probability,
 * mapped to full / gate / headline by two bands. Pinned rules are never judged.
 * `shadow` records what it would have done and delivers everything whole;
 * `live` delivers by level. Once a call is set to be judged, anything that
 * keeps the answer from coming back — its settings, its credential or its
 * allowance could not be read, the allowance is used up, the judge failed —
 * delivers exactly as before and says so in `rule_gate`, with the reason.
 * There is no second provider to fall back to.
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
    @injectBudgetGuard()
    private readonly budget: Pick<BudgetGuard, 'status'>,
    @injectRuleGateConfig()
    private readonly config: RuleGateConfig
  ) {}

  async apply(input: RuleGateInput): Promise<RuleGateOutcome> {
    const unjudged = input.rules.map(deliverUnjudged);
    const unchanged: RuleGateOutcome = { rules: unjudged, block: null };
    const mode = this.config.mode;
    if (mode === 'off' || input.task === null) return unchanged;
    const unpinned = input.rules.filter(
      (rule): rule is JudgedRule => !rule.pinned && Boolean(rule.id)
    );
    if (unpinned.length === 0) return unchanged;
    const attempt = await this.#attempt(
      input.subjectId,
      input.task,
      unpinned,
      input.taskDetail
    );
    // The account has the judge off, or no judge is configured for it: not
    // judged, and nothing to record.
    if (attempt === null) return unchanged;
    return this.#outcome(input.rules, unjudged, mode, attempt);
  }

  /**
   * One attempt to judge the call. Null only for an intentional skip: the
   * account has not turned the judge on, or no judge is configured for it.
   * Every failure on the way is an attempt without an answer, named.
   */
  async #attempt(
    subjectId: string,
    task: string,
    unpinned: readonly JudgedRule[],
    taskDetail: RuleGateInput['taskDetail']
  ): Promise<JudgeAttempt | null> {
    const unanswered = (
      provider: JudgeProviderName,
      model: string,
      reason: UnavailableReason | undefined
    ): JudgeAttempt => ({
      provider,
      model,
      result: null,
      ids: {},
      ...(reason ? { reason } : {}),
    });
    const defaults = (provider: JudgeProviderName) =>
      [provider, this.config.defaultModels[provider]] as const;

    // The settings first: the key lookup decrypts a stored key, and an
    // account that has not turned the judge on must not pay for it.
    let settings: JudgeSettings;
    try {
      settings = await this.settings.read(subjectId);
    } catch (error) {
      logger.warn('judge settings unreadable; rules delivered whole', {
        error: messageOf(error),
      });
      return unanswered(
        ...defaults(this.config.defaultProvider),
        'settings_unavailable'
      );
    }
    if (!settings.enabled) return null;

    let credential: ResolvedJudgeCredential | null;
    try {
      credential = await this.credentials.resolve(
        subjectId,
        settings.provider ?? undefined
      );
    } catch (error) {
      logger.warn('judge credential unreadable; rules delivered whole', {
        error: messageOf(error),
      });
      return unanswered(
        ...defaults(settings.provider ?? this.config.defaultProvider),
        'credential_unavailable'
      );
    }
    if (!credential) return null;

    // On the instance's key the judge runs only while the account's
    // extraction allowance has room: an account that may not spend the
    // instance's money on extraction gets none spent on judging either. Its
    // tokens are not counted against that allowance (a decision-model token
    // is not a generation token), so judging can never pause extraction. An
    // account's own key is its own spend and is never held back. Read with
    // `status`, not `check`: the gate refuses nothing, it only delivers the
    // rules whole, so there is no decision to put on the audit record.
    if (!credential.ownedByCaller) {
      let allowed: boolean;
      try {
        allowed = (await this.budget.status('extraction', { subjectId }))
          .allowed;
      } catch (error) {
        logger.warn('extraction allowance unreadable; rules delivered whole', {
          error: messageOf(error),
        });
        return unanswered(
          credential.provider,
          credential.model,
          'budget_unavailable'
        );
      }
      if (!allowed) {
        return unanswered(
          credential.provider,
          credential.model,
          'budget_exhausted'
        );
      }
    }

    // Read only now that the judge will be asked: an account that does not
    // judge never pays for the card read.
    const detail = await this.#detailOf(taskDetail);
    const { state, questions, ids } = ruleGateRequest(
      detail ? `${task} ${detail}` : task,
      unpinned
    );
    let result: JudgmentResult;
    try {
      result = await this.judgmentFor(credential).judge(
        { state, questions, purpose: 'rule_gate', subjectId },
        { timeoutMs: this.config.timeoutMs }
      );
    } catch (error) {
      // A refused request names its status only: the provider's body can
      // quote what it was sent, and that is the owner's rules and task.
      if (error instanceof JudgeRequestError) {
        logger.warn('judge refused the request; rules delivered whole', {
          status: error.status,
        });
      } else {
        logger.warn(
          error instanceof JudgeUnavailableError
            ? 'judge unavailable; rules delivered whole'
            : 'judge failed; rules delivered whole',
          { error: messageOf(error) }
        );
      }
      // No answer in time, or a refusal to answer now, is the judge being
      // unavailable; anything else is an error on the way.
      return unanswered(
        credential.provider,
        credential.model,
        error instanceof JudgeUnavailableError ? undefined : 'judge_error'
      );
    }
    // Metered only once a judgment came back: a failed call spent nothing
    // the provider reported. The row has the shape of every other model
    // call's, so the rollups read it the same way.
    recordUsage(this.usage, {
      eventType: 'llm_extraction',
      quantity: result.usage.inputTokens + result.usage.outputTokens,
      unit: 'tokens',
      subjectId,
      metadata: {
        input_tokens: result.usage.inputTokens,
        output_tokens: result.usage.outputTokens,
        // Spend the instance never paid for: the rollups leave it out.
        ...(credential.ownedByCaller ? { own_key: true } : {}),
        model: result.model,
        provider: result.provider,
        purpose: 'rule_gate',
      },
    });
    return { provider: credential.provider, model: result.model, result, ids };
  }

  /**
   * The rest of the task when there is one to read. A card that cannot be
   * read costs the judge only that detail: the statement is still judged.
   */
  async #detailOf(
    taskDetail: RuleGateInput['taskDetail']
  ): Promise<string | null> {
    if (!taskDetail) return null;
    try {
      return await taskDetail();
    } catch (error) {
      logger.warn('card detail unreadable; judged on the statement alone', {
        error: messageOf(error),
      });
      return null;
    }
  }

  /** The call's delivery and its record, from what the attempt came to. */
  #outcome(
    rules: readonly ContextRule[],
    unjudged: ContextRule[],
    mode: 'shadow' | 'live',
    attempt: JudgeAttempt
  ): RuleGateOutcome {
    const { result } = attempt;
    const judgeUnavailable = result === null;
    // Each answer back to the rule its question named.
    const answered = new Map<string, number>();
    for (const [name, ruleId] of Object.entries(attempt.ids)) {
      const answer = result?.answers[name];
      if (answer) answered.set(ruleId, answer.noul);
    }

    const levelled = rules.map((rule) => {
      if (rule.pinned || !rule.id) {
        return { rule: deliverAtLevel(rule, 'full'), p: null as number | null };
      }
      const p = answered.get(rule.id) ?? null;
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
    // Shadow mode and a call without an answer both hand the session the
    // rules as an unjudged call gets them; the block still says what happened.
    const asBefore = mode === 'shadow' || judgeUnavailable;
    const deliveredRules = asBefore
      ? unjudged
      : ordered.map((entry) => entry.rule);
    // Over the same rules: what the session would have received whole, and
    // what it does receive.
    const baseline = rules.reduce((sum, rule) => sum + rule.text.length, 0);
    const delivered = deliveredRules.reduce(
      (sum, rule) => sum + ruleChars(rule),
      0
    );
    const counts = { full: 0, gate: 0, headline: 0 };
    for (const entry of ordered) counts[entry.rule.level ?? 'full'] += 1;

    const block: RuleGateBlock = {
      mode,
      provider: attempt.provider,
      model: attempt.model,
      latency_ms: result?.latencyMs ?? 0,
      judge_unavailable: judgeUnavailable,
      ...(attempt.reason ? { unavailable_reason: attempt.reason } : {}),
      bands: { hi: this.config.hi, lo: this.config.lo },
      chars_baseline: baseline,
      chars_delivered: delivered,
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
    return { rules: deliveredRules, block };
  }
}
