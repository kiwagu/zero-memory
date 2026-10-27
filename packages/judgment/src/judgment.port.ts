import { inject } from '@workspace/di';

/**
 * Port: a typed judgment — a few yes/no questions over one state, answered
 * with calibrated probabilities by a decision model (TypeSafe Jev, SubQ Snap).
 * Code owns the workflow; the model supplies one number per question. No
 * text is generated, so an answer can never rewrite what it judged.
 */
export const JUDGE_PROVIDER_NAMES = ['typesafe', 'subq'] as const;
export type JudgeProviderName = (typeof JUDGE_PROVIDER_NAMES)[number];

export interface NoulQuestion {
  readonly kind: 'noul';
  /** What is being judged, referencing state paths in backticks. */
  readonly instructions: string;
  /** What counts as yes and what counts as no. */
  readonly criteria: { readonly true: string; readonly false: string };
}

export type JudgmentPurpose = 'rule_gate';

export interface JudgmentRequest {
  readonly state: Record<string, unknown>;
  readonly questions: Record<string, NoulQuestion>;
  /** Metering purpose — which feature spent the tokens. */
  readonly purpose: JudgmentPurpose;
  /** Whose call this is; null for background work. */
  readonly subjectId: string | null;
}

export interface NoulAnswer {
  /** Probability that the answer is yes, 0..1. */
  readonly noul: number;
}

export interface JudgmentResult {
  /**
   * Keyed by question name. A missing key means the judge gave no answer to
   * that question; answers to questions that were not asked never appear.
   */
  readonly answers: Record<string, NoulAnswer>;
  readonly model: string;
  readonly provider: JudgeProviderName;
  readonly usage: {
    readonly inputTokens: number;
    readonly outputTokens: number;
  };
  readonly latencyMs: number;
}

export interface IJudgment {
  judge(
    request: JudgmentRequest,
    options?: { readonly timeoutMs?: number }
  ): Promise<JudgmentResult>;
}

/** The provider did not answer in time, or refused (429/529) — not a verdict. */
export class JudgeUnavailableError extends Error {
  constructor(
    message: string,
    readonly cause?: unknown
  ) {
    super(message);
    this.name = 'JudgeUnavailableError';
  }
}

/**
 * The provider refused the request itself — a non-retryable non-2xx: the
 * request is wrong and a retry won't help. The message carries the start of
 * the provider's body for whoever handles the error; `status` alone is what a
 * log line should carry.
 */
export class JudgeRequestError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
    this.name = 'JudgeRequestError';
  }
}

/**
 * The account's judge settings could not be read. Not the same as an account
 * that never turned the judge on: the gate reports the call as unavailable
 * instead of treating it as off.
 */
export class JudgeSettingsUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JudgeSettingsUnavailableError';
  }
}

/**
 * Whether the account holds its own judge key could not be established: the
 * lookup failed, or what it returned is not a credential. Only an established
 * absence may fall back to the instance's key; anything else could judge an
 * account's rules on a key, and with a provider, it never chose.
 */
export class JudgeCredentialUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JudgeCredentialUnavailableError';
  }
}

export const JUDGMENT = Symbol.for('zero-memory:judgment');
export const injectJudgment = () => inject(JUDGMENT);
