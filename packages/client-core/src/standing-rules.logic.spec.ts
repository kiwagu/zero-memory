import { describe, expect, it } from 'vitest';

import {
  mergeStandingRules,
  renderStandingRulesSection,
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

  it('carries a rule of any length in full — this channel has no cap', () => {
    const long = 'x'.repeat(5000);
    const section = renderStandingRulesSection([{ text: long, pinned: true }]);
    expect(section).toContain(long);
  });
});
