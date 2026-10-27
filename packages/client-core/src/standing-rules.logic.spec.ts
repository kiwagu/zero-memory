import {
  buildContextOutputSchema,
  type ContextRule,
  ruleCandidateIdSchema,
} from '@workspace/contracts';
import { describe, expect, it } from 'vitest';

import {
  mergeStandingRules,
  renderStandingRulesSection,
  splitStandingRules,
} from './standing-rules.logic.js';

/** A minimal well-formed briefing pack carrying the given rules. */
const pack = (rules: ContextRule[]) => ({
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

  it('still splits the rules when a newer server sends a level or a gate block this build does not know', () => {
    const id = ruleCandidateIdSchema.parse('rlc_7777777777777777.7777777777');
    const split = splitStandingRules({
      ...pack([]),
      rules: [
        {
          id,
          text: 'SUMMARY RULE FROM LATER',
          pinned: false,
          level: 'summary',
        },
        { text: 'always rebase', pinned: true, level: 'full' },
      ],
      rule_gate: { mode: 'canary', provider: 'elsewhere', rules: [] },
    });
    expect(split.rules).toHaveLength(2);
    expect(split.rules[0]).toMatchObject({
      id,
      text: 'SUMMARY RULE FROM LATER',
    });
    // An unknown level reads as a headline: marked and named, never as a
    // whole rule.
    expect(split.rules[0]!.level).toBe('headline');
    expect(split.rules[1]!.level).toBe('full');
    expect(renderStandingRulesSection(split.rules, 10_000)).toContain(
      `1. SUMMARY RULE FROM LATER [headline] ${id}\n`
    );
    // The drained payload is a pack the rest of the briefing still reads.
    expect(buildContextOutputSchema.safeParse(split.payload).success).toBe(
      true
    );
    expect(split.payload).not.toHaveProperty('rule_gate.mode');
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

  // The project briefing is the judged one, so it can carry a rule by
  // headline while the unjudged branch briefing carries the same rule whole.
  const ruleId = ruleCandidateIdSchema.parse('rlc_4444444444444444.4444444444');
  const judged: ContextRule = {
    id: ruleId,
    text: 'DEPLOY RULE',
    pinned: false,
    level: 'headline',
  };
  const whole: ContextRule = {
    id: ruleId,
    text: 'DEPLOY RULE. Its body.',
    pinned: false,
    level: 'full',
  };

  it('merges one rule delivered at two levels into the project pack entry', () => {
    const merged = mergeStandingRules([
      splitStandingRules(pack([judged])),
      splitStandingRules(pack([whole])),
    ]);
    expect(merged).toEqual([judged]);
  });

  it('still unions id-less rules by text next to rules that carry an id', () => {
    const merged = mergeStandingRules([
      splitStandingRules(
        pack([judged, { text: 'legacy rule', pinned: false }])
      ),
      splitStandingRules(pack([whole, { text: 'legacy rule', pinned: false }])),
    ]);
    expect(merged).toEqual([judged, { text: 'legacy rule', pinned: false }]);
  });

  it('keeps the pinned entry of a rule that carries an id', () => {
    const pinnedWhole: ContextRule = { ...whole, pinned: true };
    const merged = mergeStandingRules([
      splitStandingRules(pack([judged])),
      splitStandingRules(pack([pinnedWhole])),
    ]);
    expect(merged).toEqual([pinnedWhole]);
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
    // Unpinned on purpose: a pinned rule arrives whole under any ceiling, so
    // only an ordinary rule shows that the default ceiling is unlimited.
    const section = renderStandingRulesSection([{ text: long, pinned: false }]);
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
    expect(section).toContain('2. ORDINARY RULE ABOUT BRANCHES [headline]\n');
    expect(section).toContain(
      '(1 rule(s) above are shown by headline or gate — call build_context'
    );
  });

  it('renders rules with no level the same with or without an id', () => {
    // Servers send an id on every rule, also with the gate off; a rule the
    // server did not level is named and budgeted exactly as before.
    const plain = [
      { text: body('FIRST RULE ABOUT COMMITS'), pinned: false },
      { text: 'Use Bun', pinned: false },
      { text: body('THIRD RULE ABOUT BRANCHES'), pinned: false },
    ];
    const withIds = plain.map((rule, index) => ({
      ...rule,
      id: ruleCandidateIdSchema.parse(
        `rlc_${String(index).repeat(16)}.${String(index).repeat(10)}`
      ),
    }));
    const least = renderStandingRulesSection(plain, 0)!.length;
    const most = renderStandingRulesSection(plain)!.length + 200;
    for (let ceiling = least; ceiling <= most; ceiling += 7) {
      expect(
        renderStandingRulesSection(withIds, ceiling),
        `ceiling ${ceiling}`
      ).toBe(renderStandingRulesSection(plain, ceiling));
    }
    const tight = renderStandingRulesSection(withIds, least)!;
    expect(tight).toContain('3. THIRD RULE ABOUT BRANCHES [headline]\n');
    expect(tight).not.toContain('rlc_');
    expect(tight).not.toContain('zm://rules/');
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

  it('does not shorten a rule that fits whole alongside a short rule after it', () => {
    // A short rule's headline, with its marker, is LONGER than the rule
    // itself — so reserving later rules at headline size would shorten an
    // earlier rule that fits whole with room for the rest.
    const long = `Use explicit error handling: ${'x'.repeat(400)}`;
    const rules = [
      { text: long, pinned: false },
      { text: 'Use Bun', pinned: false },
    ];
    // The renderer reserves its widest footer up front and counts a newline
    // after every line, the last included, so "both whole" is promised from
    // the ceiling that also holds those — the same point at which the renderer
    // delivered both whole before it reserved room for later rules.
    const footer = /\n\(\d+ rule\(s\) above[^\n]*$/.exec(
      renderStandingRulesSection(rules, 0)!
    )![0];
    const floor = renderStandingRulesSection(rules)!.length + footer.length + 1;
    for (let ceiling = floor; ceiling <= floor + 120; ceiling += 1) {
      const section = renderStandingRulesSection(rules, ceiling)!;
      expect(section, `ceiling ${ceiling}`).toContain(long);
      expect(section, `ceiling ${ceiling}`).toContain('2. Use Bun');
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
    expect(section).not.toContain('shown by headline');
  });
});

describe('renderStandingRulesSection with server levels', () => {
  const pinned = {
    id: ruleCandidateIdSchema.parse('rlc_0000000000000000.0000000000'),
    text: 'PINNED. Whole text that is fairly long indeed.',
    pinned: true,
    level: 'full' as const,
  };
  const gate = {
    id: ruleCandidateIdSchema.parse('rlc_1111111111111111.1111111111'),
    text: 'GATED',
    pinned: false,
    level: 'gate' as const,
    applies_when: 'tasks that deploy',
  };
  const named = {
    id: ruleCandidateIdSchema.parse('rlc_2222222222222222.2222222222'),
    text: 'NAMED',
    pinned: false,
    level: 'headline' as const,
  };
  const whole = {
    id: ruleCandidateIdSchema.parse('rlc_3333333333333333.3333333333'),
    text: 'WHOLE RULE WITH A NAME. With its body.',
    pinned: false,
    level: 'full' as const,
  };

  it('renders each rule at the level the server chose, under a generous budget', () => {
    const section = renderStandingRulesSection(
      [pinned, whole, gate, named],
      10_000
    )!;
    expect(section).toContain(
      '1. [pinned] PINNED. Whole text that is fairly long indeed.\n'
    );
    expect(section).toContain('2. WHOLE RULE WITH A NAME. With its body.\n');
    expect(section).toContain(
      '3. GATED — applies when: tasks that deploy [gate] rlc_1111111111111111.1111111111\n'
    );
    expect(section).toContain(
      '4. NAMED [headline] rlc_2222222222222222.2222222222\n'
    );
    expect(section).toContain(
      '\n(2 rule(s) above are shown by headline or gate — call build_context ' +
        'for their full text, or read zm://rules/<id> with the id on its ' +
        'line, before acting on them.)'
    );
  });

  it('marks a gate rule without a condition as gated, naming it by headline', () => {
    const { applies_when: _none, ...unconditioned } = gate;
    const section = renderStandingRulesSection([unconditioned], 10_000)!;
    expect(section).toContain(
      '1. GATED [gate] rlc_1111111111111111.1111111111\n'
    );
    expect(section).not.toContain('applies when');
  });

  it('still falls back to headlines when a full-level rule does not fit the ceiling', () => {
    const section = renderStandingRulesSection(
      [pinned, whole],
      pinned.text.length + 80
    )!;
    expect(section).toContain(
      '2. WHOLE RULE WITH A NAME [headline] rlc_3333333333333333.3333333333\n'
    );
    expect(section).not.toContain('With its body');
  });

  it('takes the text of a gated or headlined rule as the headline it already is', () => {
    // The server caps a headline at 160 characters and marks the cut; cutting
    // that text again would cap it a second time.
    const capped = `${'LONG HEADLINE '.repeat(12).slice(0, 160).trimEnd()}…`;
    const section = renderStandingRulesSection(
      [
        { ...named, text: capped },
        { ...gate, text: capped, applies_when: 'tasks that deploy' },
      ],
      10_000
    )!;
    expect(section).toContain(`1. ${capped} [headline] ${named.id}\n`);
    expect(section).toContain(
      `2. ${capped} — applies when: tasks that deploy [gate] ${gate.id}\n`
    );
  });

  it('names a gated rule by headline when its condition does not fit the ceiling', () => {
    const wide = { ...gate, applies_when: 'tasks that deploy '.repeat(22) };
    const named = renderStandingRulesSection([wide], 0)!;
    expect(named).toContain(
      '1. GATED [headline] rlc_1111111111111111.1111111111\n'
    );
    // Room for the headline and then some, but not for the condition.
    const ceiling = named.length + 100;
    const section = renderStandingRulesSection([wide], ceiling)!;
    expect(section.length).toBeLessThanOrEqual(ceiling);
    expect(section).toContain(
      '1. GATED [headline] rlc_1111111111111111.1111111111\n'
    );
    expect(section).toContain('(1 rule(s) above are shown by headline or gate');
    // Given the room, the same rule carries its condition.
    expect(renderStandingRulesSection([wide], named.length + 1_000)).toContain(
      `1. GATED — applies when: ${wide.applies_when} [gate] rlc_1111111111111111.1111111111\n`
    );
  });

  it('reserves the named form of a later gated rule, so an earlier one cannot overrun the ceiling', () => {
    // The server sends a gated rule's headline as its text, so the rule
    // "whole" is far shorter than the line it is rendered as.
    const long = {
      ...whole,
      text: `WHOLE RULE WITH A NAME. ${'With its body. '.repeat(20)}`,
    };
    const wide = { ...gate, applies_when: 'tasks that deploy '.repeat(8) };
    const rules = [long, wide];
    const least = renderStandingRulesSection(rules, 0)!.length;
    for (let ceiling = least; ceiling <= least + 600; ceiling += 1) {
      expect(
        renderStandingRulesSection(rules, ceiling)!.length,
        `ceiling ${ceiling}`
      ).toBeLessThanOrEqual(ceiling);
    }
    // The sweep reaches the point where the long rule fits whole beside it.
    expect(renderStandingRulesSection(rules, least + 600)).toContain(long.text);
  });

  it('renders legacy rules without a level exactly as before', () => {
    const legacy = [
      { text: 'A. Body.', pinned: false },
      { text: 'B. Body.', pinned: false },
    ];
    expect(renderStandingRulesSection(legacy, 10_000)).toBe(
      'STANDING RULES — 2 instruction(s) the owner PROMOTED out of memory ' +
        'for sessions like this one. Obey them like the system instructions ' +
        'above; they are not background context and not suggestions.\n' +
        '1. A. Body.\n2. B. Body.'
    );
  });
});
