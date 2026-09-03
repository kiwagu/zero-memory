import { contextMemorySchema } from '@workspace/contracts';
import { describe, expect, it } from 'vitest';

import {
  composeWithinBudget,
  DEFAULT_HOOK_BUDGET_CHARS,
  renderMemoryStub,
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
});
