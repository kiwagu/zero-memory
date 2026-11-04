/**
 * A read result fits what the client shows inline. A board list pages on past
 * its first page; a result over the client's limit is cut to it, says what it
 * left out and pages on from the last row delivered; a limit the agent
 * reported holds for the rest of its session; and each fit is metered.
 */
import { expect, test } from '@playwright/test';

import { admin } from '../helpers/board-store.js';
import { contentText, firstJson, McpTestClient } from '../helpers/mcp.js';
import { readSeedState } from '../helpers/runtime-state.js';
import {
  entityIdOf,
  passwordGrantToken,
  provisionE2EUser,
} from '../helpers/users.js';

interface Page {
  cards: Array<{ number: number }>;
  has_more: boolean;
  next_before: string | null;
  fit?: {
    budget: number;
    source: string;
    chars: number;
    delivered: number;
    omitted: Record<string, number>;
  };
}

const markers: string[] = [];

test.afterAll(async () => {
  if (markers.length > 0) {
    await admin().from('memories').delete().in('id', markers);
  }
});

/** A fresh project board with `count` cards; numbers newest first. */
const boardWith = async (
  mcp: McpTestClient,
  label: string,
  count: number,
  title: (i: number) => string
): Promise<{ scope: string; newestFirst: number[] }> => {
  const made = firstJson<{ scope: string; memory_id: string }>(
    await mcp.callTool('remember', {
      content: `result-fit ${label} marker ${Date.now()}: the relay drops frames`,
      kind: 'fact',
      project_hint: `/tmp/zm-e2e-result-fit-${label}-${Date.now()}`,
    })
  );
  markers.push(made.memory_id);
  const numbers: number[] = [];
  for (let i = 0; i < count; i += 1) {
    const created = firstJson<{ card: { number: number } }>(
      await mcp.callTool('card', {
        action: 'create',
        scope: made.scope,
        title: title(i),
        type: 'task',
        no_links: 'e2e fixture',
      })
    );
    numbers.push(created.card.number);
  }
  return { scope: made.scope, newestFirst: numbers.reverse() };
};

test('a board list pages on past its first page, each card exactly once', async () => {
  const seed = await readSeedState();
  const mcp = await McpTestClient.connect(await passwordGrantToken(seed.userA));
  try {
    const { scope, newestFirst } = await boardWith(
      mcp,
      'pages',
      5,
      (i) => `Pager ${i}`
    );
    const page = async (before?: string): Promise<Page> => {
      const listed = await mcp.callTool('board', {
        action: 'list',
        scope,
        limit: 2,
        ...(before ? { before } : {}),
      });
      expect(listed.isError ?? false).toBe(false);
      return firstJson<Page>(listed);
    };

    const first = await page();
    expect(first.cards.map((c) => c.number)).toEqual(newestFirst.slice(0, 2));
    expect(first.has_more).toBe(true);
    const second = await page(first.next_before ?? undefined);
    expect(second.cards.map((c) => c.number)).toEqual(newestFirst.slice(2, 4));
    expect(second.has_more).toBe(true);
    const last = await page(second.next_before ?? undefined);
    expect(last.cards.map((c) => c.number)).toEqual(newestFirst.slice(4));
    expect(last.has_more).toBe(false);
    expect(last.next_before).toBeNull();

    // A cursor that does not parse is refused, not read as "from the start".
    const garbled = await mcp.callTool('board', {
      action: 'list',
      scope,
      before: 'not-a-cursor',
    });
    expect(garbled.isError).toBe(true);
    expect(contentText(garbled)).toContain('next_before');
  } finally {
    await mcp.close();
  }
});

test('a result over the reported limit is cut to it, pages on from what it delivered, and the limit holds for the session', async () => {
  const seed = await readSeedState();
  const subject = await entityIdOf(seed.userA.id);
  const since = new Date().toISOString();
  const mcp = await McpTestClient.connect(await passwordGrantToken(seed.userA));
  try {
    const { scope, newestFirst } = await boardWith(mcp, 'cut', 24, (i) =>
      `Fit ${i} `.padEnd(190, 'x')
    );

    const cut = await mcp.callTool('board', {
      action: 'list',
      scope,
      max_chars: 8_000,
    });
    expect(cut.isError ?? false).toBe(false);
    const body = firstJson<Page>(cut);
    // The premise: all of them were read and would not fit.
    expect(body.fit?.chars).toBeGreaterThan(8_000);
    expect(contentText(cut).length).toBeLessThanOrEqual(8_000);
    expect(body.fit).toMatchObject({ budget: 8_000, source: 'call' });
    expect(body.cards.length).toBeGreaterThan(0);
    expect(body.fit?.omitted).toEqual({ cards: 24 - body.cards.length });
    expect(body.cards.map((c) => c.number)).toEqual(
      newestFirst.slice(0, body.cards.length)
    );
    expect(body.has_more).toBe(true);
    expect(contentText(cut)).toContain(
      'NOTE: this result was held to 8,000 characters'
    );

    // Paging on, with no limit reported again: the session still holds the
    // reported one, and every card arrives once, in the board's order.
    const seen = body.cards.map((c) => c.number);
    let before = body.next_before;
    while (before) {
      const next = await mcp.callTool('board', {
        action: 'list',
        scope,
        before,
      });
      expect(next.isError ?? false).toBe(false);
      const page = firstJson<Page>(next);
      if (page.fit) {
        expect(page.fit).toMatchObject({ budget: 8_000, source: 'session' });
      }
      expect(contentText(next).length).toBeLessThanOrEqual(8_000);
      seen.push(...page.cards.map((c) => c.number));
      before = page.has_more ? page.next_before : null;
    }
    expect(seen).toEqual(newestFirst);

    // The report and the cut were metered, sizes and counts only.
    await expect
      .poll(async () => {
        const { data, error } = await admin()
          .from('usage_events')
          .select('metadata')
          .eq('event_type', 'result_fit')
          .eq('user_id', subject)
          .contains('metadata', { tool: 'board', reported: 8_000 })
          .gte('occurred_at', since);
        expect(error).toBeNull();
        return (data ?? []).map((row) => row.metadata);
      })
      .toContainEqual(
        expect.objectContaining({
          budget: 8_000,
          source: 'call',
          omitted: { cards: 24 - body.cards.length },
        })
      );
  } finally {
    await mcp.close();
  }
});

test('a card read over the reported limit continues its text, attachments and history from where each stopped', async () => {
  const seed = await readSeedState();
  const mcp = await McpTestClient.connect(await passwordGrantToken(seed.userA));
  try {
    const { scope } = await boardWith(mcp, 'card', 0, () => '');
    // Text with lines and escapes, so chunks must join back exactly.
    const text = Array.from(
      { length: 70 },
      (_, i) => `Line ${i}: "quoted" text, then a tab\tand more.`
    ).join('\n');
    const created = firstJson<{ card: { id: string; number: number } }>(
      await mcp.callTool('card', {
        action: 'create',
        scope,
        title: 'Fit a long card',
        body: text.padEnd(7_000, '.'),
        type: 'task',
        no_links: 'e2e fixture',
      })
    ).card;
    const urls = Array.from(
      { length: 12 },
      (_, i) => `https://example.com/attachment-${i}`
    );
    for (const url of urls) {
      const attached = await mcp.callTool('card_log', {
        action: 'attach',
        card_id: created.id,
        ref_kind: 'url',
        ref_target: url,
      });
      expect(attached.isError ?? false).toBe(false);
    }
    for (let i = 0; i < 10; i += 1) {
      const noted = await mcp.callTool('card_log', {
        action: 'note',
        card_id: created.id,
        text: `Step ${i}: ${'n'.repeat(500)}`,
      });
      expect(noted.isError ?? false).toBe(false);
    }

    interface CardRead {
      card: { body: string };
      refs: Array<{ target: string }>;
      events: Array<{ seq: number }>;
      has_more: boolean;
      next_after_seq: number;
      body_next: number | null;
      refs_next: number | null;
      fit?: Page['fit'] & { cut?: Record<string, number> };
    }
    const read = async (args: Record<string, unknown>): Promise<CardRead> => {
      const result = await mcp.callTool('board', {
        action: 'get',
        card_id: created.id,
        ...args,
      });
      expect(result.isError ?? false).toBe(false);
      expect(contentText(result).length).toBeLessThanOrEqual(
        (args.max_chars as number | undefined) ?? 30_000
      );
      return firstJson<CardRead>(result);
    };

    // The whole card, read before any limit was reported.
    const whole = await read({});
    expect(whole.fit).toBeUndefined();
    expect(whole.refs.map((ref) => ref.target)).toEqual(urls);
    const allSeqs = whole.events.map((e) => e.seq);
    expect(allSeqs.length).toBeGreaterThanOrEqual(20);

    const first = await read({ max_chars: 8_000 });
    // The premise: everything had to give way, the text included.
    expect(first.fit?.omitted).toMatchObject({ events: expect.any(Number) });
    expect(first.fit?.cut?.['card.body']).toBeGreaterThan(0);
    expect(first.body_next).toBe(first.card.body.length);
    expect(first.refs_next).toBe(first.refs.length);

    // Each part reads on from where it stopped, with the session's limit,
    // and joins back to exactly the whole.
    let body = first.card.body;
    for (let at = first.body_next; at !== null;) {
      const page = await read({ body_from: at });
      body += page.card.body;
      at = page.body_next;
    }
    expect(body).toBe(whole.card.body);

    const refs = first.refs.map((ref) => ref.target);
    for (let at = first.refs_next; at !== null;) {
      const page = await read({ refs_from: at });
      refs.push(...page.refs.map((ref) => ref.target));
      at = page.refs_next;
    }
    expect(refs).toEqual(urls);

    const seqs = first.events.map((e) => e.seq);
    for (let more = first.has_more, after = first.next_after_seq; more;) {
      const page = await read({ after_seq: after });
      seqs.push(...page.events.map((e) => e.seq));
      more = page.has_more;
      after = page.next_after_seq;
    }
    expect(seqs).toEqual(allSeqs);

    // Resolving a number takes a reported limit too, and acknowledges it.
    const resolved = firstJson<{ fit?: Page['fit'] }>(
      await mcp.callTool('board', {
        action: 'resolve',
        scope,
        number: created.number,
        max_chars: 9_000,
      })
    );
    expect(resolved.fit).toMatchObject({ budget: 9_000, source: 'call' });
  } finally {
    await mcp.close();
  }
});

test('a briefing over the reported limit names its standing rules by headline, each one read away in full', async () => {
  // An account of its own: its General rules reach no other spec's briefing.
  const user = await provisionE2EUser('result-fit-rules@zm.e2e');
  const mcp = await McpTestClient.connect(await passwordGrantToken(user));
  try {
    // Four distinct facts: near-identical ones would be deduplicated into one
    // memory, and so into one rule.
    const facts = [
      'replies stay short and say what changed',
      'commit subjects name the goal of the change',
      'the full test suite runs before every push',
      'documentation moves in the same change as the code',
    ];
    const ruleTexts: string[] = [];
    for (const [i, fact] of facts.entries()) {
      const memory = firstJson<{ memory_id: string }>(
        await mcp.callTool('remember', {
          content: `result-fit marker ${Date.now()}: ${fact}`,
          kind: 'preference',
          scope: 'personal',
        })
      ).memory_id;
      const text = (
        `RESULT-FIT RULE ${i} (every project): ${fact}. ` +
        'Say what changed and why, then stop. '.repeat(52)
      )
        .slice(0, 2_000)
        .trimEnd();
      const promoted = await mcp.callTool('promote_rule', {
        memory_id: memory,
        rule_text: text,
      });
      expect(promoted.isError ?? false).toBe(false);
      ruleTexts.push(text);
    }

    const briefing = await mcp.callTool('build_context', {
      topic: 'how to keep replies short',
      briefing: true,
      max_chars: 8_000,
    });
    expect(briefing.isError ?? false).toBe(false);
    const text = contentText(briefing);
    expect(text.length).toBeLessThanOrEqual(8_000);
    const pack = firstJson<{ fit?: { cut?: Record<string, number> } }>(
      briefing
    );
    expect(pack.fit?.cut?.rules).toBeGreaterThan(0);

    // Every rule is still named, with the id that reads it whole.
    const ids = [
      ...text.matchAll(/RESULT-FIT RULE \d[^\n]*\[headline\] (rlc_\S+)/gu),
    ].map((match) => match[1]!);
    expect(ids).toHaveLength(4);
    const whole = await Promise.all(
      ids.map((id) =>
        mcp.readResourceJson<{ rule: { text: string } }>(`zm://rules/${id}`)
      )
    );
    expect(whole.map((read) => read.rule.text).sort()).toEqual(
      [...ruleTexts].sort()
    );
  } finally {
    await mcp.close();
  }
});
