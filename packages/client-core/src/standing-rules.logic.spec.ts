import { describe, expect, it } from 'vitest';

import {
  mergeStandingRules,
  renderStandingRulesSection,
  ruleHeadline,
  splitStandingRules,
} from './standing-rules.logic.js';

/** A minimal well-formed briefing pack carrying the given rules. */
const pack = (rules: { text: string; pinned: boolean }[]) => ({
  memories: [],
  entities: [],
  edges: [],
  linked_memories: [],
  recent: [],
  rules,
  open_loops: [],
  open_loops_total: 0,
});

describe('splitStandingRules', () => {
  it('drains the rules out of the payload so the JSON dump repeats nothing', () => {
    const split = splitStandingRules(
      pack([{ text: 'always rebase', pinned: false }])
    );
    expect(split.rules).toEqual([{ text: 'always rebase', pinned: false }]);
    expect((split.payload as { rules: unknown[] }).rules).toEqual([]);
  });

  it('passes an unparsable payload through untouched', () => {
    const alien = { something: 'else' };
    const split = splitStandingRules(alien);
    expect(split.payload).toBe(alien);
    expect(split.rules).toEqual([]);
  });
});

describe('mergeStandingRules', () => {
  it('unions by text and puts pinned rules first', () => {
    const merged = mergeStandingRules([
      splitStandingRules(
        pack([
          { text: 'unpinned A', pinned: false },
          { text: 'pinned B', pinned: true },
        ])
      ),
      splitStandingRules(pack([{ text: 'unpinned C', pinned: false }])),
    ]);
    expect(merged.map((rule) => rule.text)).toEqual([
      'pinned B',
      'unpinned A',
      'unpinned C',
    ]);
  });

  it('de-dupes the same rule delivered by both briefings, keeping the pin', () => {
    const merged = mergeStandingRules([
      splitStandingRules(pack([{ text: 'same rule', pinned: false }])),
      splitStandingRules(pack([{ text: 'same rule', pinned: true }])),
    ]);
    expect(merged).toEqual([{ text: 'same rule', pinned: true }]);
  });
});

describe('renderStandingRulesSection', () => {
  it('renders nothing when the owner has no rules', () => {
    expect(renderStandingRulesSection([])).toBeNull();
  });

  it('renders rules as binding instructions, not as recorded data', () => {
    const section = renderStandingRulesSection([
      { text: 'merge only on explicit approval', pinned: false },
    ]);
    expect(section).toContain('STANDING RULES');
    expect(section).toContain('1. merge only on explicit approval');
    // The framing is what separates this section from the open-loops one:
    // rules are obeyed, loops are judged.
    expect(section).toContain('Obey them');
    expect(section).toContain('not background context');
  });

  it('marks pinned rules and explains the guarantee only when one exists', () => {
    const withPin = renderStandingRulesSection([
      { text: 'guaranteed rule', pinned: true },
      { text: 'ordinary rule', pinned: false },
    ]);
    expect(withPin).toContain('1. [pinned] guaranteed rule');
    expect(withPin).toContain('2. ordinary rule');
    expect(withPin).toContain('guaranteed reach every');

    const withoutPin = renderStandingRulesSection([
      { text: 'ordinary rule', pinned: false },
    ]);
    expect(withoutPin).not.toContain('[pinned]');
    expect(withoutPin).not.toContain('guaranteed reach every');
  });

  it('carries a rule of any length in full when no ceiling is given', () => {
    const long = 'x'.repeat(5000);
    const section = renderStandingRulesSection([{ text: long, pinned: true }]);
    expect(section).toContain(long);
  });

  const body = (headline: string): string =>
    `${headline}. ${'The reasoning behind it runs on at length. '.repeat(30)}`;

  it('keeps pinned rules whole even past the ceiling, and headlines the rest', () => {
    const pinned = body('PINNED RULE: never touch production');
    const ordinary = body('ORDINARY RULE ABOUT BRANCHES');
    const section = renderStandingRulesSection(
      [
        { text: pinned, pinned: true },
        { text: ordinary, pinned: false },
      ],
      800
    )!;
    // The guarantee the owner pinned it for outranks the ceiling.
    expect(section).toContain(pinned);
    expect(section).not.toContain(ordinary);
    expect(section).toContain('2. ORDINARY RULE ABOUT BRANCHES [headline]');
    expect(section).toContain(
      '(1 rule(s) above are shown by headline only — call build_context'
    );
  });

  it('keeps non-pinned rules inside the ceiling whenever their headlines fit', () => {
    const rules = Array.from({ length: 8 }, (_, i) => ({
      text: `Rule ${i} ${'r'.repeat(1_300)}`,
      pinned: false,
    }));
    // The smallest this section can be: every rule by headline, plus footer.
    const allHeadlines = renderStandingRulesSection(rules, 0)!.length;
    for (let ceiling = allHeadlines; ceiling <= 12_000; ceiling += 97) {
      expect(
        renderStandingRulesSection(rules, ceiling)!.length,
        `ceiling ${ceiling}`
      ).toBeLessThanOrEqual(ceiling);
    }
  });

  it('carries the others in full while they fit and adds no footer when all do', () => {
    const section = renderStandingRulesSection(
      [
        { text: 'short rule one', pinned: false },
        { text: 'short rule two', pinned: false },
      ],
      2000
    )!;
    expect(section).toContain('1. short rule one');
    expect(section).toContain('2. short rule two');
    expect(section).not.toContain('[headline]');
    expect(section).not.toContain('headline only');
  });
});

describe('ruleHeadline', () => {
  it('ends at the first sentence break after the opening', () => {
    expect(
      ruleHeadline(
        'NO PRIVATE REFERENCES IN COMMITTED ARTIFACTS (every project) — the ' +
          'rest explains why.'
      )
    ).toBe('NO PRIVATE REFERENCES IN COMMITTED ARTIFACTS (every project)');
    expect(ruleHeadline('Production systems are READ-ONLY. Always.')).toBe(
      'Production systems are READ-ONLY'
    );
  });

  it('does not break inside an open parenthesis', () => {
    expect(
      ruleHeadline(
        'NORTH STAR (keep it in view — not only when asked): the rest follows.'
      )
    ).toBe('NORTH STAR (keep it in view — not only when asked)');
  });

  it('caps an opening that never breaks', () => {
    const headline = ruleHeadline('word '.repeat(100));
    expect(headline.length).toBeLessThanOrEqual(161);
    expect(headline.endsWith('…')).toBe(true);
  });
});
