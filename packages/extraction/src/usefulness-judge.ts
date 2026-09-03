import { inject } from '@workspace/di';

import type { UsefulnessVerdict } from './usefulness-judge.schema.js';

/** A recalled memory the judge scores: its id and the text that was shown. */
export interface RecalledFact {
  id: string;
  content: string;
}

/**
 * Port: given a transcript chunk and the memories a recall surfaced while it
 * was produced, judge which ones the agent actually used. The out-of-band
 * usefulness signal (full coverage; the in-band supersedes/derived_from channel
 * covers only writes). Implementations must return a verdict per input fact.
 */
export interface IUsefulnessJudge {
  judge(
    transcript: string,
    facts: RecalledFact[]
  ): Promise<UsefulnessVerdict[]>;
}

export const USEFULNESS_JUDGE = Symbol.for('zero-memory:usefulness-judge');

export const injectUsefulnessJudge = () => inject(USEFULNESS_JUDGE);
