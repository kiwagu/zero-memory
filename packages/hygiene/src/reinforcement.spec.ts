import { describe, expect, it } from 'vitest';

import {
  computeMultiplier,
  DEFAULT_REINFORCEMENT_CONFIG,
  type ReinforcementSignal,
} from './reinforcement.js';

const config = DEFAULT_REINFORCEMENT_CONFIG;

const signal = (
  overrides: Partial<ReinforcementSignal> = {}
): ReinforcementSignal => ({
  inBandEvents: 0,
  judgeConfidence: 0,
  misledEvents: 0,
  misledConfidence: 0,
  promoted: false,
  ...overrides,
});

describe('computeMultiplier', () => {
  it('is neutral without any signal', () => {
    expect(computeMultiplier(signal())).toBe(1);
  });

  it('boosts smoothly with usefulness and stays monotonic', () => {
    const one = computeMultiplier(signal({ inBandEvents: 1 }));
    const five = computeMultiplier(signal({ inBandEvents: 5 }));
    expect(one).toBeGreaterThan(1);
    expect(five).toBeGreaterThan(one);
    expect(five).toBeLessThanOrEqual(config.boostCap);
  });

  it('caps the boost however loud the signal (anti-gaming)', () => {
    expect(
      computeMultiplier(signal({ inBandEvents: 10_000, judgeConfidence: 500 }))
    ).toBe(config.boostCap);
  });

  it('judge confidence counts fractionally next to in-band proof', () => {
    const judgeOnly = computeMultiplier(signal({ judgeConfidence: 0.7 }));
    const inBand = computeMultiplier(signal({ inBandEvents: 1 }));
    expect(judgeOnly).toBeGreaterThan(1);
    expect(judgeOnly).toBeLessThan(inBand);
  });

  it('demotes a promoted-to-rules memory regardless of its boost', () => {
    expect(
      computeMultiplier(
        signal({ inBandEvents: 50, judgeConfidence: 10, promoted: true })
      )
    ).toBe(config.promotedMultiplier);
    expect(config.promotedMultiplier).toBeLessThan(1);
  });

  it('demotes below neutral on misled evidence alone', () => {
    const one = computeMultiplier(signal({ misledEvents: 1 }));
    const three = computeMultiplier(signal({ misledEvents: 3 }));
    expect(one).toBeLessThan(1);
    expect(three).toBeLessThan(one);
    expect(three).toBeGreaterThanOrEqual(config.misledFloor);
  });

  it('nets misled evidence against a usefulness boost', () => {
    const boosted = computeMultiplier(signal({ inBandEvents: 5 }));
    const contested = computeMultiplier(
      signal({ inBandEvents: 5, misledEvents: 1 })
    );
    expect(contested).toBeLessThan(boosted);
    expect(contested).toBeGreaterThan(config.misledFloor);
  });

  it('never demotes past the floor (retirement is triage, not ranking)', () => {
    expect(
      computeMultiplier(signal({ misledEvents: 10_000, misledConfidence: 500 }))
    ).toBe(config.misledFloor);
    expect(config.misledFloor).toBeGreaterThan(0);
  });

  it('judge misled confidence counts fractionally next to a challenge', () => {
    const judgeOnly = computeMultiplier(signal({ misledConfidence: 0.7 }));
    const challenged = computeMultiplier(signal({ misledEvents: 1 }));
    expect(judgeOnly).toBeLessThan(1);
    expect(judgeOnly).toBeGreaterThan(challenged);
  });

  it('keeps every output inside the table check constraint (0, 2]', () => {
    for (const candidate of [
      signal({ promoted: true }),
      signal({ inBandEvents: 1_000_000 }),
      signal({ judgeConfidence: 0.6 }),
      signal({ misledEvents: 1_000_000 }),
      signal({ inBandEvents: 3, misledEvents: 3 }),
    ]) {
      const multiplier = computeMultiplier(candidate);
      expect(multiplier).toBeGreaterThan(0);
      expect(multiplier).toBeLessThanOrEqual(2);
    }
  });
});
