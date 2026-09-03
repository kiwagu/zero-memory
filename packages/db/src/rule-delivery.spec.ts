import { describe, expect, it } from 'vitest';

import {
  capUnpinnedRules,
  deliveredRuleCount,
  RULE_DELIVERY,
} from './rule-delivery.js';

const CAP = RULE_DELIVERY.generalRulesCap;

describe('deliveredRuleCount', () => {
  it('caps the unpinned rules', () => {
    expect(deliveredRuleCount(0, 5, CAP)).toBe(5);
    expect(deliveredRuleCount(0, 100, CAP)).toBe(CAP);
  });

  it('delivers every pinned rule ON TOP of the cap', () => {
    // The pin's promise: a pinned rule is never the one that gets dropped,
    // so it does not consume a capped slot either.
    expect(deliveredRuleCount(10, 100, CAP)).toBe(10 + CAP);
    expect(deliveredRuleCount(3, 0, CAP)).toBe(3);
  });

  it('matches the naive min() only while nothing is pinned', () => {
    // This is the bug the function exists to prevent: with pins in play,
    // min(everything, cap) understates what the reader actually delivers.
    const pinned = 10;
    const unpinned = 100;
    const naive = Math.min(pinned + unpinned, CAP);
    expect(deliveredRuleCount(pinned, unpinned, CAP)).toBeGreaterThan(naive);
    expect(deliveredRuleCount(0, unpinned, CAP)).toBe(naive);
  });

  it('never returns a negative count', () => {
    expect(deliveredRuleCount(-1, -1, CAP)).toBe(0);
  });
});

describe('capUnpinnedRules', () => {
  const rule = (text: string, pinned = false) => ({ text, pinned });

  it('keeps every pinned rule and caps the rest', () => {
    const rules = [
      rule('pinned a', true),
      ...Array.from({ length: 20 }, (_, i) => rule(`plain ${i}`)),
      rule('pinned b', true),
    ];
    const delivered = capUnpinnedRules(rules, 3);
    expect(delivered.map((r) => r.text)).toEqual([
      'pinned a',
      'pinned b',
      'plain 0',
      'plain 1',
      'plain 2',
    ]);
  });

  it('agrees with the counter it mirrors', () => {
    // The two must never disagree: one drives the list a session receives,
    // the other drives the number the owner reads on /rules.
    const rules = [
      ...Array.from({ length: 4 }, (_, i) => rule(`pin ${i}`, true)),
      ...Array.from({ length: 30 }, (_, i) => rule(`plain ${i}`)),
    ];
    expect(capUnpinnedRules(rules, CAP)).toHaveLength(
      deliveredRuleCount(4, 30, CAP)
    );
  });
});
