import {
  JUDGE_PROVIDER_NAMES,
  type JudgeProviderName,
} from './judgment.port.js';

export interface JudgeConfig {
  /** Platform default provider when an account has not chosen one. */
  readonly provider: JudgeProviderName;
  readonly timeoutMs: number;
  readonly models: Record<JudgeProviderName, string>;
  /** Platform keys per provider; a provider without one is not configured. */
  readonly platformKeys: Partial<Record<JudgeProviderName, string>>;
}

export type RuleGateMode = 'off' | 'shadow' | 'live';

export interface RuleGateConfig {
  readonly mode: RuleGateMode;
  /** p >= hi → full text. */
  readonly hi: number;
  /** lo <= p < hi → gate (headline + applies_when); p < lo → headline. */
  readonly lo: number;
  /** Per-request judge timeout; the same `ZM_JUDGE_TIMEOUT_MS` knob as the judge's. */
  readonly timeoutMs: number;
}

const DEFAULT_MODELS: Record<JudgeProviderName, string> = {
  typesafe: 'jev-1.14.0',
  subq: 'subq-snap-1.1',
};

const DEFAULT_TIMEOUT_MS = 1500;

const isProvider = (value: string): value is JudgeProviderName =>
  (JUDGE_PROVIDER_NAMES as readonly string[]).includes(value);

const positiveInt = (
  name: string,
  raw: string | undefined,
  fallback: number
) => {
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer, got "${raw}"`);
  }
  return parsed;
};

const unitInterval = (
  name: string,
  raw: string | undefined,
  fallback: number
) => {
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed >= 1) {
    throw new Error(
      `${name} must be a number strictly between 0 and 1, got "${raw}"`
    );
  }
  return parsed;
};

const readTimeoutMs = (env: NodeJS.ProcessEnv) =>
  positiveInt(
    'ZM_JUDGE_TIMEOUT_MS',
    env.ZM_JUDGE_TIMEOUT_MS,
    DEFAULT_TIMEOUT_MS
  );

export const readJudgeConfig = (env: NodeJS.ProcessEnv): JudgeConfig => {
  const rawProvider = env.ZM_JUDGE_PROVIDER || 'typesafe';
  if (!isProvider(rawProvider)) {
    throw new Error(
      `ZM_JUDGE_PROVIDER must be one of ${JUDGE_PROVIDER_NAMES.join(', ')}, got "${rawProvider}"`
    );
  }
  const platformKeys: Partial<Record<JudgeProviderName, string>> = {};
  if (env.ZM_TYPESAFE_API_KEY) platformKeys.typesafe = env.ZM_TYPESAFE_API_KEY;
  // SNAPQ_API_KEY is the owner's name for the SubQ Snap key; keep it.
  if (env.SNAPQ_API_KEY) platformKeys.subq = env.SNAPQ_API_KEY;
  return {
    provider: rawProvider,
    timeoutMs: readTimeoutMs(env),
    models: {
      typesafe: env.ZM_JUDGE_MODEL_TYPESAFE || DEFAULT_MODELS.typesafe,
      subq: env.ZM_JUDGE_MODEL_SUBQ || DEFAULT_MODELS.subq,
    },
    platformKeys,
  };
};

export const readRuleGateConfig = (env: NodeJS.ProcessEnv): RuleGateConfig => {
  const rawMode = env.ZM_RULE_GATE_MODE || 'off';
  if (rawMode !== 'off' && rawMode !== 'shadow' && rawMode !== 'live') {
    throw new Error(
      `ZM_RULE_GATE_MODE must be off, shadow or live, got "${rawMode}"`
    );
  }
  const hi = unitInterval('ZM_RULE_GATE_HI', env.ZM_RULE_GATE_HI, 0.6);
  const lo = unitInterval('ZM_RULE_GATE_LO', env.ZM_RULE_GATE_LO, 0.35);
  if (lo >= hi) {
    throw new Error(
      `ZM_RULE_GATE_HI (${hi}) must be greater than ZM_RULE_GATE_LO (${lo})`
    );
  }
  return { mode: rawMode, hi, lo, timeoutMs: readTimeoutMs(env) };
};
