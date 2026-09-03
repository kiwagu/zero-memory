import {
  LlmRoiJudge,
  DeterministicRoiJudge,
  type IRoiJudge,
} from './roi-judge.js';
import {
  LlmRoiProber,
  DeterministicRoiProber,
  type IRoiProber,
} from './roi-prober.js';
import { RoiRunner } from './roi-runner.js';

/**
 * Wires the runner with the model-backed prober/judge, or the deterministic
 * pair under ZM_EXTRACTOR=deterministic — the same switch the extractor and
 * usefulness judge ride, so key-free smoke runs cover the whole benchmark.
 */
export const createRoiRunner = (): RoiRunner => {
  const deterministic = process.env.ZM_EXTRACTOR === 'deterministic';
  const prober: IRoiProber = deterministic
    ? new DeterministicRoiProber()
    : new LlmRoiProber();
  const judge: IRoiJudge = deterministic
    ? new DeterministicRoiJudge()
    : new LlmRoiJudge();
  return new RoiRunner(undefined, prober, judge);
};
