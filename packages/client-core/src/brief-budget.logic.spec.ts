import { contextMemorySchema, memoryKindSchema } from '@workspace/contracts';
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

  it('never renders longer than the budget it was given, at any budget', () => {
    // A mixed pack — a couple of small memories (whole at nearly every
    // budget below), a couple of medium ones (whole at generous budgets,
    // stub-size at tighter ones), and a couple of large ones (never whole,
    // always stub-or-dropped) — sized to cross every boundary this function
    // has as the sweep runs: how many fit whole, how many fit as a stub,
    // whether the `(+N more not listed)` tail shows, and whether the JSON
    // envelope block and the stub block both exist and need their `\n\n`
    // join. `text.length <= budgetChars` is the one invariant this function
    // exists to guarantee — every caller downstream (the composer) enforces
    // its own budget in the same strict, no-partial-credit way, so a pack
    // that comes back even one character over gets dropped WHOLESALE by
    // that composer instead of degrading to a stub or a starved notice.
    const input = pack([
      memory('mem_aaaaaaaaaaaaaaaa.01kzzzzzz1', 'x'.repeat(80)),
      memory('mem_bbbbbbbbbbbbbbbb.01kzzzzzz2', 'x'.repeat(80)),
      memory('mem_cccccccccccccccc.01kzzzzzz3', 'x'.repeat(400)),
      memory('mem_dddddddddddddddd.01kzzzzzz4', 'x'.repeat(400)),
      memory('mem_eeeeeeeeeeeeeeee.01kzzzzzz5', 'x'.repeat(1_500)),
      memory('mem_ffffffffffffffff.01kzzzzzz6', 'x'.repeat(1_500)),
    ]);

    for (let budget = 50; budget <= 3_000; budget += 7) {
      const rendered = renderPackWithinBudget('topic', input, budget);
      expect(
        rendered.text.length,
        `budget ${budget}: rendered ${rendered.text.length} chars`
      ).toBeLessThanOrEqual(budget);
    }
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
});

describe('planSectionBudgets — memory floor', () => {
  it('holds a floor for the memory pack, so long rules cannot take it all', () => {
    const withPack = planSectionBudgets(9_000, 500, true, 12);
    const withoutPack = planSectionBudgets(9_000, 500, true, 0);
    expect(withPack.memoryFloor).toBeGreaterThan(0);
    // The floor comes out of the rules' ceiling, character for character.
    expect(withoutPack.rules - withPack.rules).toBe(withPack.memoryFloor);
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

  it.each(memoryKindSchema.options)(
    'seats the stub block itself, so ONE %s memory handed exactly its floor still gets a stub',
    (kind) => {
      // A floor of one stub's width alone is not a floor: before the first
      // stub line, the renderer spends its intro line (~115 characters plus
      // the topic) and reserves its "(+N more not listed)" line, so a one-
      // memory project squeezed down to its floor came back starved every
      // time. Content far too long to arrive whole, so the stub is at its
      // widest, and a real project directory name as the topic.
      const trimmed = renderPackWithinBudget(
        'zero-memory',
        pack([
          memory('mem_aaaaaaaaaaaaaaaa.01kzzzzzz1', 'x'.repeat(4_000), kind),
        ]),
        memoryFloorChars(1)
      );
      expect(trimmed.starved).toBe(false);
      expect(trimmed.text).toContain('(id: mem_aaaaaaaaaaaaaaaa.01kzzzzzz1)');
      expect(trimmed.text.length).toBeLessThanOrEqual(memoryFloorChars(1));
    }
  );
});
