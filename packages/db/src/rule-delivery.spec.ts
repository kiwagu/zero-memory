import { describe, expect, it } from 'vitest';

import {
  capUnpinnedRules,
  deliverableRules,
  deliveredRuleCount,
  deliveredRuleIds,
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
    // so it does not consume a capped slot either — which is why a naive
    // min(everything, cap) would understate delivery once anything is pinned.
    expect(deliveredRuleCount(10, 100, CAP)).toBe(10 + CAP);
    expect(deliveredRuleCount(3, 0, CAP)).toBe(3);
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

const NOW = Date.parse('2026-09-28T12:00:00Z');
const DAY = 86_400_000;
const TTL = RULE_DELIVERY.deliveryTtlDays;
const msAgo = (ms: number) => new Date(NOW - ms).toISOString();
const daysAgo = (days: number) => msAgo(days * DAY);

describe('deliverableRules', () => {
  // The readers (briefing and instructions) and the /rules page all take
  // their age rule from here, so this table is where the TTL is pinned.
  it.each<[string, boolean, string | null, boolean]>([
    ['delivers a fresh unpinned rule', false, daysAgo(1), true],
    [
      'delivers an unpinned rule promoted exactly at the cutoff',
      false,
      daysAgo(TTL),
      true,
    ],
    [
      'drops an unpinned rule one moment past the cutoff',
      false,
      msAgo(TTL * DAY + 1),
      false,
    ],
    [
      'delivers a pinned rule long past the cutoff',
      true,
      daysAgo(TTL + 30),
      true,
    ],
    ['drops an unpinned rule with no promotion time', false, null, false],
    ['delivers a pinned rule with no promotion time', true, null, true],
  ])('%s', (_name, pinned, promotedAt, delivered) => {
    const rule = { id: 'r', pinned, promotedAt };
    expect(deliverableRules([rule], NOW)).toEqual(delivered ? [rule] : []);
  });

  it('orders pinned rules first, then newest first', () => {
    const rules = [
      { id: 'old', pinned: false, promotedAt: daysAgo(30) },
      { id: 'pinned-old', pinned: true, promotedAt: daysAgo(200) },
      { id: 'new', pinned: false, promotedAt: daysAgo(1) },
      { id: 'pinned-new', pinned: true, promotedAt: daysAgo(2) },
      // Where Postgres sorts a null in a descending order: first.
      { id: 'pinned-undated', pinned: true, promotedAt: null },
    ];
    expect(deliverableRules(rules, NOW).map((rule) => rule.id)).toEqual([
      'pinned-undated',
      'pinned-new',
      'pinned-old',
      'new',
      'old',
    ]);
  });
});

describe('deliveredRuleIds', () => {
  const general = (id: string, promotedDaysAgo: number, pinned = false) => ({
    id,
    targetLayer: 'user' as const,
    effectiveScope: 'user.usr_a',
    pinned,
    promotedAt: daysAgo(promotedDaysAgo),
  });
  const project = (
    id: string,
    scope: string,
    promotedDaysAgo: number,
    pinned = false
  ) => ({
    id,
    targetLayer: 'project' as const,
    effectiveScope: scope,
    pinned,
    promotedAt: daysAgo(promotedDaysAgo),
  });

  it('caps the unpinned General rules newest first, pinned ones on top', () => {
    const rows = [
      general('pinned', 80, true),
      ...Array.from({ length: CAP + 1 }, (_, i) => general(`g${i}`, i)),
    ];
    const delivered = deliveredRuleIds(rows, NOW);
    expect(delivered.has('pinned')).toBe(true);
    expect(delivered.has('g0')).toBe(true);
    expect(delivered.has(`g${CAP - 1}`)).toBe(true);
    // The oldest unpinned one is the one past the cap.
    expect(delivered.has(`g${CAP}`)).toBe(false);
    expect(delivered.size).toBe(CAP + 1);
  });

  it('caps each project on its own, apart from the General rules', () => {
    const projectCap = RULE_DELIVERY.projectRulesCap;
    const rows = [
      ...Array.from({ length: projectCap + 1 }, (_, i) =>
        project(`a${i}`, 'proj.a', i)
      ),
      project('b0', 'proj.b', 50),
      general('g0', 1),
    ];
    const delivered = deliveredRuleIds(rows, NOW);
    expect(delivered.has(`a${projectCap}`)).toBe(false);
    expect(delivered.has('a0')).toBe(true);
    expect(delivered.has('b0')).toBe(true);
    expect(delivered.has('g0')).toBe(true);
  });

  it('agrees with the counter the /rules badge shows', () => {
    const rows = [
      ...Array.from({ length: 3 }, (_, i) => general(`p${i}`, 200, true)),
      ...Array.from({ length: 20 }, (_, i) => general(`u${i}`, i)),
      general('expired', RULE_DELIVERY.deliveryTtlDays + 5),
    ];
    expect(deliveredRuleIds(rows, NOW).size).toBe(
      deliveredRuleCount(3, 20, CAP)
    );
  });
});
