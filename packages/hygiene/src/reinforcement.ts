/**
 * Usage reinforcement: facts that proved useful rise in ranking, facts
 * promoted into an always-on rules file sink (they are delivered guaranteed
 * and no longer need rank). The signal (recall_used events) lives in the
 * deny-all usage_events table, so the hygiene cycle PRECOMPUTES one
 * content-free multiplier per memory into memory_reinforcement;
 * search_memories just multiplies. The curve below is the single tuning
 * point — the DB stores only the finished multiplier.
 */

/** Tuning knobs for one reinforcement rollup run. */
export interface ReinforcementConfig {
  /** recall_used lookback window for the usefulness evidence. */
  windowDays: number;
  /** Boost slope: multiplier = 1 + boostRate * ln(1 + usefulness). */
  boostRate: number;
  /**
   * Boost ceiling (anti-gaming): however often a fact fired, it can never
   * crowd the top-k by more than this factor.
   */
  boostCap: number;
  /**
   * Multiplier for memories promoted into a rules file: the always-on layer
   * delivers them guaranteed, so a high rank would pay for them twice.
   * Overrides the usefulness boost.
   */
  promotedMultiplier: number;
  /** Demotion slope for misled evidence, mirroring boostRate. */
  misledRate: number;
  /**
   * Demotion floor: misled evidence only DEMOTES ranking, never buries a
   * memory outright — retirement goes through the review queue, so the
   * record must stay findable enough to be adjudicated.
   */
  misledFloor: number;
}

export const DEFAULT_REINFORCEMENT_CONFIG: ReinforcementConfig = {
  windowDays: 90,
  boostRate: 0.15,
  boostCap: 1.4,
  promotedMultiplier: 0.6,
  misledRate: 0.25,
  misledFloor: 0.5,
};

/** One memory's usefulness evidence, as returned by the signal rollup. */
export interface ReinforcementSignal {
  /** In-band confirmations: deterministic proof of use, weight 1 each. */
  inBandEvents: number;
  /**
   * Sum of judge confidences (each >= 0.6): probabilistic evidence, weighted
   * by the judge's own certainty.
   */
  judgeConfidence: number;
  /** Explicit agent challenges: deterministic misled attribution, weight 1. */
  misledEvents: number;
  /** Sum of judge misled confidences (each >= 0.6). */
  misledConfidence: number;
  /** The memory lives in an always-on rules file. */
  promoted: boolean;
}

/**
 * The reinforcement curve: smooth log growth with a hard cap, a mirrored
 * log demotion for misled evidence with a hard floor, demotion for
 * promoted-to-rules memories, neutral 1.0 when there is no signal at all.
 * Pure — exported for tests and for the eval harness.
 */
export const computeMultiplier = (
  signal: ReinforcementSignal,
  config: ReinforcementConfig = DEFAULT_REINFORCEMENT_CONFIG
): number => {
  if (signal.promoted) {
    return config.promotedMultiplier;
  }
  const usefulness = signal.inBandEvents + signal.judgeConfidence;
  const misledness = signal.misledEvents + signal.misledConfidence;
  const boost =
    usefulness > 0
      ? Math.min(
          config.boostCap,
          1 + config.boostRate * Math.log(1 + usefulness)
        )
      : 1;
  if (misledness <= 0) {
    return boost;
  }
  return Math.max(
    config.misledFloor,
    boost - config.misledRate * Math.log(1 + misledness)
  );
};
