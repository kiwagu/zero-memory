import type { ContextRule } from '@workspace/contracts';
import { RULE_DELIVERY } from '@workspace/db';
import { describe, expect, it } from 'vitest';

import { clientCapsInstructions, composeInstructions } from './mcp-server.js';

const rule = (text: string, pinned = false): ContextRule => ({ text, pinned });

/** A client with no documented instructions cap. */
const OPEN_CLIENT = 'some-mcp-client';
/** The one client documented to truncate the channel. */
const CAPPED_CLIENT = 'claude-code';

describe('composeInstructions', () => {
  it('returns the base router unchanged when nothing is promoted', () => {
    for (const client of [OPEN_CLIENT, CAPPED_CLIENT, null]) {
      const base = composeInstructions([], client).text;
      expect(base).toContain('zero-memory is the user');
      expect(base).not.toContain('OWNER RULES');
    }
  });

  it('carries the rule texts natively for a client with no cap', () => {
    const composed = composeInstructions(
      [rule('merge only on explicit approval'), rule('live is read-only')],
      OPEN_CLIENT
    ).text;
    expect(composed).toContain('OWNER RULES');
    expect(composed).toContain('1. merge only on explicit approval');
    expect(composed).toContain('2. live is read-only');
    // No install required to receive them: the protocol is the channel.
    expect(composed).not.toContain('NOT reproduced here');
  });

  it('marks pinned rules inline', () => {
    const composed = composeInstructions(
      [rule('guaranteed', true), rule('ordinary')],
      OPEN_CLIENT
    ).text;
    expect(composed).toContain('1. [pinned] guaranteed');
    expect(composed).toContain('2. ordinary');
  });

  it('announces without text for a client that truncates the channel', () => {
    const rules = [rule('a'.repeat(600)), rule('b'.repeat(600))];
    const { text: composed, dropped } = composeInstructions(
      rules,
      CAPPED_CLIENT
    );
    expect(composed).toContain('OWNER RULES');
    expect(composed).toContain('2 standing');
    expect(composed).toContain('NOT reproduced here');
    expect(composed).not.toContain('a'.repeat(600));
    // A truncating client must still receive the router and the pointer to
    // the call that delivers the texts — that is the whole budget invariant.
    expect(composed.length).toBeLessThanOrEqual(
      RULE_DELIVERY.instructionVisibleBudget
    );
    expect(composed).toContain('build_context');
    // Nothing was forced out: the compact announcement fits by design.
    expect(dropped).toEqual([]);
  });

  it('keeps a capped client inside the budget at any rule count', () => {
    for (const count of [1, 12, 500]) {
      const rules = Array.from({ length: count }, (_, i) =>
        rule(`rule ${i + 1}: ${'x'.repeat(400)}`)
      );
      expect(
        composeInstructions(rules, CAPPED_CLIENT).text.length
      ).toBeLessThanOrEqual(RULE_DELIVERY.instructionVisibleBudget);
    }
  });

  it('clips an absurdly long rule when texts are inlined', () => {
    const composed = composeInstructions(
      [rule('x'.repeat(9000))],
      OPEN_CLIENT
    ).text;
    expect(composed.length).toBeLessThan(9000);
  });

  it('pins the router itself under the capped budget', () => {
    // The whole guard rests on this: segments are dropped whole only because
    // the mandatory first segment is known to fit. If this fails, shorten the
    // router — do not raise the budget, the client's cap is not ours to move.
    const { text, dropped } = composeInstructions([], CAPPED_CLIENT);
    expect(text.length).toBeLessThanOrEqual(
      RULE_DELIVERY.instructionVisibleBudget
    );
    expect(dropped).toEqual([]);
  });

  it('reports what a capped budget forced out, instead of overflowing', () => {
    // Simulate a future where the announcement no longer fits by measuring:
    // whatever the rule count, the emission stays inside the budget and any
    // sacrifice is REPORTED — the caller logs it, nothing is cut silently.
    for (const count of [1, 12, 500]) {
      const rules = Array.from({ length: count }, (_, i) =>
        rule(`rule ${i + 1}: ${'x'.repeat(400)}`)
      );
      const { text, dropped } = composeInstructions(rules, CAPPED_CLIENT);
      expect(text.length).toBeLessThanOrEqual(
        RULE_DELIVERY.instructionVisibleBudget
      );
      for (const name of dropped) {
        expect(['owner-rules', 'router-tail']).toContain(name);
      }
    }
  });

  it('motivates the first call, not merely orders it', () => {
    // The channel is the only voice ZM has in a plugin-less session, so it
    // must answer "what do I gain" and "what does skipping cost" — the two
    // questions an agent actually weighs before its first tool call.
    const { text } = composeInstructions([], CAPPED_CLIENT);
    expect(text).toContain('WHY THE FIRST CALL PAYS');
    expect(text).toContain('WHAT SKIPPING COSTS');
    expect(text).toContain('project_hint');
    expect(text).toContain('REFUSED');
  });

  it('treats an unknown or missing client as uncapped', () => {
    // The protocol channel is the one that works with no client-side install,
    // so it carries as much as the client is known to accept — and only a
    // DOCUMENTED cap makes us hold back.
    expect(clientCapsInstructions(null)).toBe(false);
    expect(clientCapsInstructions(undefined)).toBe(false);
    expect(clientCapsInstructions('cursor')).toBe(false);
    expect(clientCapsInstructions('  Claude-Code  ')).toBe(true);
  });
});
