/**
 * Judge re-examination: a second opinion on high-traffic memories whenever
 * the judge model changes.
 *
 * The pair scan takes only RECENT memories as subjects and never re-judges a
 * pair that already reached the review queue. Both rules earn their keep —
 * they stop a nightly cycle from re-buying the same verdicts and from
 * overturning what a person already decided — but their intersection freezes
 * every older memory at the judgement of whichever model happened to be
 * configured when it was written. A memory that surfaces in recall every week
 * is the one most worth a stronger judge's attention, and it is exactly the
 * one that never gets it.
 *
 * The missing axis is the model itself: a memory is eligible for ONE
 * re-examination per judge model. The guard rows carry that fact, so a stable
 * configuration falls silent after a bounded burst and only a model change
 * re-opens the population. Nothing here is a new verdict path — the ordinary
 * single-memory scan does the work, with its queue guard, its cross-project
 * filter and its confidence gates intact.
 */

/** Tuning knobs for one re-examination run. */
export interface JudgeRescanConfig {
  /** Lookback for the traffic count, in days. */
  windowDays: number;
  /**
   * How often a memory must have been returned by recall within the window to
   * be worth a second opinion. Traffic is the proxy for "this knowledge is in
   * use", so the spend follows what the corpus actually serves.
   */
  minSurfacings: number;
  /**
   * Memories re-examined per run — the spend brake. Each one costs at most a
   * handful of judge calls (its near neighbours), and the guard makes the
   * work finite: after enough runs every high-traffic memory has been seen by
   * the current model and the cost falls to a single rollup query.
   */
  maxSubjects: number;
  /**
   * New review-queue rows a run may produce before it stops — the TRIAGE
   * brake, and the one that matters most here. The queue is worked by hand,
   * so the scarce resource is a person's attention, not tokens: re-examining
   * old neighbourhoods the scan never reached surfaces genuinely new pairs,
   * and measured against a real corpus roughly one judged pair in seven ends
   * up queued. Filtering by the judge's confidence would not help — measured
   * on resolved history, confidence does not separate real supersedes from
   * pairs a person waved through — so the honest control is a count.
   *
   * Subjects left over when the cap is reached are simply not examined: they
   * stay unstamped and lead the next run, so nothing is dropped, only paced.
   */
  maxNewQueueRows: number;
}

export const DEFAULT_JUDGE_RESCAN_CONFIG: JudgeRescanConfig = {
  // Mirrors the reinforcement window: one notion of "recently in use".
  windowDays: 90,
  // Measured against a real corpus before this default was fixed: at three
  // surfacings the eligible population was 885 memories and the queue guard
  // removed under a tenth of their neighbour pairs, because the scan had
  // never looked at those neighbourhoods at all — so the first pass is a
  // backlog sweep of thousands of judge calls, not a model-change effect. At
  // ten it is a few hundred memories, aimed at what recall serves most, and
  // lowering it later is one number.
  minSurfacings: 10,
  maxSubjects: 5,
  // Two rows a run: at the historical queue rate that is what five subjects
  // produce anyway, so the cap bites only on an unusually productive run —
  // and it bounds the hand-triage cost no matter how the population grows.
  maxNewQueueRows: 2,
};

/** Outcome of one re-examination run. */
export interface JudgeRescanResult {
  /** The judge model the run examined memories with. */
  model: string;
  /** High-traffic memories this model had not examined yet. */
  candidates: number;
  /** Memories actually re-examined (bounded by the run's subject cap). */
  rescanned: number;
  /** Pairs the judge classified across all subjects. */
  pairsJudged: number;
  /** Pairs auto-resolved (reversible) by the ordinary scan gates. */
  autoResolved: number;
  /** Pairs sent to the owner's review queue for a decision. */
  queued: number;
  /** True when the triage cap ended the run before the subject list did. */
  stoppedOnQueueCap: boolean;
}

/** What one subject's scan contributed to the run. */
export interface JudgeRescanContribution {
  scanned: number;
  pairsJudged: number;
  autoResolved: number;
  queued: number;
}

/**
 * Fold one subject's scan outcome into the run total. `scanned` is 0 when the
 * subject vanished between the rollup and the scan (invalidated meanwhile),
 * and such a subject must not count as re-examined — otherwise a run would
 * report work it never did.
 */
export const foldRescan = (
  total: JudgeRescanResult,
  contribution: JudgeRescanContribution
): JudgeRescanResult => ({
  ...total,
  rescanned: total.rescanned + (contribution.scanned > 0 ? 1 : 0),
  pairsJudged: total.pairsJudged + contribution.pairsJudged,
  autoResolved: total.autoResolved + contribution.autoResolved,
  queued: total.queued + contribution.queued,
});
