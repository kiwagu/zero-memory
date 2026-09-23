import { contextMemorySchema } from '@workspace/contracts';
import { describe, expect, it } from 'vitest';

import {
  composeWithinBudget,
  DEFAULT_HOOK_BUDGET_CHARS,
  LOOPS_BUDGET_SHARE,
  MEMORY_FLOOR_STUBS,
  memoryFloorChars,
  planSectionBudgets,
  renderMemoryStub,
  renderStarvedPackNotice,
  resolveHookBudgetChars,
  renderPackWithinBudget,
} from './brief-budget.logic.js';
import { renderOpenLoopsSection } from './open-loops.logic.js';
import { renderStandingRulesSection } from './standing-rules.logic.js';

// Built THROUGH the contract: a hand-rolled literal would let an id or kind
// that the real pack can never contain into the fixtures, and the first draft
// of this spec did exactly that.
const memory = (id: string, content: string, kind = 'decision') =>
  contextMemorySchema.parse({
    id,
    content,
    kind,
    scope: 'user.usr_rp1h4rswqtwd61c4_01kwytx54t.core',
    created_at: '2026-08-16T09:00:00.000Z',
  });

const pack = (memories: ReturnType<typeof memory>[]) => ({
  memories,
  entities: [],
  edges: [],
  linked_memories: [],
  recent: [],
  open_loops: [],
  open_loops_total: 0,
});

describe('hook budget', () => {
  it('falls back to the measured default for a missing or junk value', () => {
    expect(resolveHookBudgetChars(undefined)).toBe(DEFAULT_HOOK_BUDGET_CHARS);
    expect(resolveHookBudgetChars('')).toBe(DEFAULT_HOOK_BUDGET_CHARS);
    expect(resolveHookBudgetChars('not-a-number')).toBe(
      DEFAULT_HOOK_BUDGET_CHARS
    );
    expect(resolveHookBudgetChars('-5')).toBe(DEFAULT_HOOK_BUDGET_CHARS);
    expect(resolveHookBudgetChars('4000')).toBe(4000);
  });
});

describe('renderStarvedPackNotice', () => {
  it('names how many memories exist and how to reach them', () => {
    const notice = renderStarvedPackNotice('zero-memory', 7);
    expect(notice).toContain('7');
    expect(notice).toContain('zero-memory');
    expect(notice).toContain('build_context');
  });
});

describe('renderPackWithinBudget — what it leaves behind', () => {
  it('reports the memories that did not arrive whole', () => {
    const memory1 = memory('mem_aaaaaaaaaaaaaaaa.01kzzzzzz1', 'x'.repeat(50));
    const memory2 = memory(
      'mem_bbbbbbbbbbbbbbbb.01kzzzzzz2',
      'x'.repeat(4_000)
    );
    const trimmed = renderPackWithinBudget(
      'topic',
      pack([memory1, memory2]),
      1_200
    );
    expect(trimmed.deliveredIds).toEqual(['mem_aaaaaaaaaaaaaaaa.01kzzzzzz1']);
    expect(trimmed.remaining.map((m) => m.id)).toEqual([
      'mem_bbbbbbbbbbbbbbbb.01kzzzzzz2',
    ]);
    expect(trimmed.starved).toBe(false);
  });

  it('marks a pack that had memories but could not show one', () => {
    const memory1 = memory(
      'mem_aaaaaaaaaaaaaaaa.01kzzzzzz1',
      'x'.repeat(4_000)
    );
    const trimmed = renderPackWithinBudget('topic', pack([memory1]), 60);
    expect(trimmed.deliveredIds).toEqual([]);
    expect(trimmed.remaining.map((m) => m.id)).toEqual([
      'mem_aaaaaaaaaaaaaaaa.01kzzzzzz1',
    ]);
    expect(trimmed.starved).toBe(true);
  });

  it('is not starved when there was nothing to show', () => {
    const trimmed = renderPackWithinBudget('topic', pack([]), 60);
    expect(trimmed.starved).toBe(false);
    expect(trimmed.remaining).toEqual([]);
    expect(trimmed.text).toBe('');
  });

  it('is not starved when a stub fit even though no whole memory did', () => {
    // Content big enough that NO whole memory can ever fit the budget below,
    // but the budget is comfortably above the intro-plus-one-stub floor — a
    // real, partial delivery (a stub naming a real id), which is strictly
    // more useful than the generic starved notice a caller would show in
    // its place if this were (wrongly) reported as starved.
    const memory1 = memory(
      'mem_aaaaaaaaaaaaaaaa.01kzzzzzz1',
      'x'.repeat(4_000)
    );
    const trimmed = renderPackWithinBudget('topic', pack([memory1]), 300);
    expect(trimmed.starved).toBe(false);
    expect(trimmed.deliveredIds).toEqual([]);
    expect(trimmed.text).toContain('mem_aaaaaaaaaaaaaaaa.01kzzzzzz1');
  });
});

describe('renderPackWithinBudget', () => {
  it('keeps whole memories and stubs the rest', () => {
    const body = 'x'.repeat(500);
    const input = pack([
      memory('mem_aaaaaaaaaaaaaaaa.01kzzzzzz1', body),
      memory('mem_bbbbbbbbbbbbbbbb.01kzzzzzz2', body),
      memory('mem_cccccccccccccccc.01kzzzzzz3', body),
    ]);

    const budget = 1400;
    const rendered = renderPackWithinBudget('topic', input, budget);

    // The contract, not an arithmetic guess: the section honours the budget,
    // every inlined memory is WHOLE (half a fact is worse than a pointer to a
    // whole one), and every memory is either inlined or named.
    expect(rendered.text.length).toBeLessThanOrEqual(budget);
    expect(rendered.deliveredIds.length).toBeGreaterThan(0);
    expect(rendered.deliveredIds.length).toBeLessThan(3);
    expect(rendered.text).toContain(body);
    for (const row of input.memories) {
      expect(
        rendered.text.includes(row.id),
        `${row.id} must be inlined or named`
      ).toBe(true);
    }
  });

  it('inlines everything and names nothing when the budget allows', () => {
    const input = pack([
      memory('mem_aaaaaaaaaaaaaaaa.01kzzzzzz1', 'short one'),
      memory('mem_bbbbbbbbbbbbbbbb.01kzzzzzz2', 'short two'),
    ]);

    const rendered = renderPackWithinBudget(
      'topic',
      input,
      DEFAULT_HOOK_BUDGET_CHARS
    );

    expect(rendered.text).not.toContain('named but not inlined');
    expect(rendered.deliveredIds).toEqual([
      'mem_aaaaaaaaaaaaaaaa.01kzzzzzz1',
      'mem_bbbbbbbbbbbbbbbb.01kzzzzzz2',
    ]);
  });

  it('drops the empty envelope and spends the budget on stubs instead', () => {
    const body = 'y'.repeat(400);
    const input = pack([
      memory('mem_aaaaaaaaaaaaaaaa.01kzzzzzz1', body),
      memory('mem_bbbbbbbbbbbbbbbb.01kzzzzzz2', body),
    ]);

    // Enough for the stub lines, nowhere near enough for a 400-char memory.
    const rendered = renderPackWithinBudget('topic', input, 500);

    expect(rendered.deliveredIds).toEqual([]);
    // No JSON envelope: it costs as much as several stubs and says nothing.
    expect(rendered.text).not.toContain('"memories"');
    expect(rendered.text).toContain('(id: mem_aaaaaaaaaaaaaaaa.01kzzzzzz1)');
    expect(rendered.text).toContain('(id: mem_bbbbbbbbbbbbbbbb.01kzzzzzz2)');
    expect(rendered.text).toContain('recall');
    expect(rendered.text.length).toBeLessThanOrEqual(500);
  });

  it('counts the stubs that did not fit rather than dropping them silently', () => {
    const body = 'y'.repeat(400);
    const input = pack(
      Array.from({ length: 9 }, (_, index) =>
        memory(`mem_aaaaaaaaaaaaaaa${index}.01kzzzzzz1`, body)
      )
    );

    const rendered = renderPackWithinBudget('topic', input, 500);

    expect(rendered.text).toMatch(/\(\+\d+ more not listed\)/u);
    expect(rendered.text.length).toBeLessThanOrEqual(500);
  });

  it('passes an unparseable payload through rather than losing a briefing', () => {
    const rendered = renderPackWithinBudget('topic', { nonsense: true }, 10);

    expect(rendered.text).toContain('{"nonsense":true}');
    expect(rendered.deliveredIds).toEqual([]);
  });

  it('a stub says what the memory is and how to fetch it', () => {
    const line = renderMemoryStub(
      memory(
        'mem_aaaaaaaaaaaaaaaa.01kzzzzzz1',
        `  chose  cursor pagination\nbecause ${'z'.repeat(200)}`,
        'gotcha'
      )
    );

    expect(line.startsWith('- [gotcha] chose cursor pagination because')).toBe(
      true
    );
    expect(line).toContain('…');
    expect(line.endsWith('(id: mem_aaaaaaaaaaaaaaaa.01kzzzzzz1)')).toBe(true);
  });
});

describe('composeWithinBudget', () => {
  it('drops from the end and says what went', () => {
    const composed = composeWithinBudget(
      [
        { name: 'the project line', text: 'PROJECT: proj.x' },
        { name: 'the standing rules', text: 'RULES: ' + 'r'.repeat(80) },
        { name: 'the memory pack', text: 'PACK: ' + 'p'.repeat(500) },
      ],
      200
    );

    expect(composed.text).toContain('PROJECT: proj.x');
    expect(composed.text).toContain('RULES:');
    expect(composed.text).not.toContain('PACK:');
    expect(composed.omitted).toEqual(['the memory pack']);
    expect(composed.text).toContain('did not fit');
  });

  it('never drops the leading section, however tight the budget', () => {
    const composed = composeWithinBudget(
      [{ name: 'the project line', text: 'PROJECT: proj.x' }],
      1
    );

    expect(composed.text).toBe('PROJECT: proj.x');
    expect(composed.omitted).toEqual([]);
  });

  it('skips absent sections without reporting them as omitted', () => {
    const composed = composeWithinBudget(
      [
        { name: 'the project line', text: 'PROJECT: proj.x' },
        { name: 'the standing rules', text: null },
      ],
      1000
    );

    expect(composed.omitted).toEqual([]);
    expect(composed.text).toBe('PROJECT: proj.x');
  });

  it('reports a section that was dropped for size', () => {
    const composed = composeWithinBudget(
      [
        { name: 'the project line', text: 'p' },
        { name: 'the memory pack', text: 'x'.repeat(500) },
      ],
      100
    );
    expect(composed.omitted).toEqual(['the memory pack']);
    expect(composed.text).toContain('did not fit');
  });

  it('says nothing about a section that had nothing to say', () => {
    const composed = composeWithinBudget(
      [
        { name: 'the project line', text: 'p' },
        { name: 'the memory pack', text: null },
      ],
      9_000
    );
    expect(composed.omitted).toEqual([]);
    expect(composed.text).toBe('p');
  });
});

describe('planSectionBudgets', () => {
  it('holds the loops a floor and gives the rules the rest as a ceiling', () => {
    const plan = planSectionBudgets(9000, 400, true);
    const floor = Math.floor(9000 * LOOPS_BUDGET_SHARE);
    expect(plan.rules).toBeLessThanOrEqual(9000 - 400 - floor);
    expect(plan.rules).toBeGreaterThan(9000 - 400 - floor - 50);
  });

  it('holds nothing back when there are no loops to deliver', () => {
    expect(planSectionBudgets(9000, 400, false).rules).toBeGreaterThan(
      planSectionBudgets(9000, 400, true).rules
    );
  });

  it('never plans a negative ceiling', () => {
    expect(planSectionBudgets(100, 400, true).rules).toBe(0);
  });
});

describe('the briefing split, end to end', () => {
  // The measured defect: 8,455 characters of rules, a 9,000 budget, and a
  // project line — the loops got nothing, then the rules did not fit either.
  const rule = (headline: string, pinned: boolean) => ({
    text: `${headline}. ${'Why it holds, at length. '.repeat(55)}`,
    pinned,
  });
  const rules = [
    rule('PINNED ONE', true),
    rule('PINNED TWO', true),
    rule('ORDINARY THREE', false),
    rule('ORDINARY FOUR', false),
    rule('ORDINARY FIVE', false),
    rule('ORDINARY SIX', false),
  ];
  const loops = [1, 2, 3].map((n) =>
    contextMemorySchema.parse({
      id: `mem_${String(n).padStart(16, '0')}.0000000000`,
      content: `handover ${n}: finish the migration and verify it`,
      kind: 'task',
      scope: 'proj.alpha',
      created_at: `2026-09-0${n}T00:00:00Z`,
    })
  );
  const projectLine = `PROJECT: proj.alpha — ${'x'.repeat(400)}`;

  it('delivers the pinned rules whole and the loops, and drops neither', () => {
    const budget = 9000;
    const plan = planSectionBudgets(budget, projectLine.length, true);
    const rulesSection = renderStandingRulesSection(rules, plan.rules)!;
    const loopSection = renderOpenLoopsSection(
      loops,
      loops.length,
      new Date('2026-09-10T00:00:00Z'),
      budget - projectLine.length - rulesSection.length - 8
    );
    const composed = composeWithinBudget(
      [
        { name: 'the project line', text: projectLine },
        { name: 'the standing rules', text: rulesSection },
        { name: 'the open loops', text: loopSection },
      ],
      budget
    );

    expect(composed.omitted).toEqual([]);
    expect(composed.text.length).toBeLessThanOrEqual(budget);
    expect(composed.text).toContain(rules[0]!.text);
    expect(composed.text).toContain(rules[1]!.text);
    expect(composed.text).toContain('[headline]');
    expect(composed.text).toContain('handover 3');
  });
});

describe('planSectionBudgets — memory floor', () => {
  it('holds a floor for the memory pack, so long rules cannot take it all', () => {
    const plan = planSectionBudgets(9_000, 500, true, 12);
    expect(plan.memoryFloor).toBe(memoryFloorChars(12));
    expect(plan.rules).toBe(9_000 - 500 - 2_250 - plan.memoryFloor - 16);
  });

  it('asks for no floor when the pack has no memories', () => {
    expect(planSectionBudgets(9_000, 500, true, 0).memoryFloor).toBe(0);
  });

  it('never asks for more floor than the memories it has', () => {
    expect(memoryFloorChars(3)).toBeLessThan(memoryFloorChars(10));
    expect(memoryFloorChars(50)).toBe(memoryFloorChars(MEMORY_FLOOR_STUBS));
  });

  it('gives the rules nothing rather than a negative ceiling', () => {
    expect(planSectionBudgets(600, 500, true, 12).rules).toBe(0);
  });
});
