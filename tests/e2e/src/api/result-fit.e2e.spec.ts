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
import { entityIdOf, passwordGrantToken } from '../helpers/users.js';

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
    const { scope, newestFirst } = await boardWith(mcp, 'cut', 12, (i) =>
      `Fit ${i} `.padEnd(190, 'x')
    );

    const cut = await mcp.callTool('board', {
      action: 'list',
      scope,
      max_chars: 4_000,
    });
    expect(cut.isError ?? false).toBe(false);
    const body = firstJson<Page>(cut);
    // The premise: all twelve were read and would not fit.
    expect(body.fit?.chars).toBeGreaterThan(4_000);
    expect(contentText(cut).length).toBeLessThanOrEqual(4_000);
    expect(body.fit).toMatchObject({ budget: 4_000, source: 'call' });
    expect(body.cards.length).toBeGreaterThan(0);
    expect(body.fit?.omitted).toEqual({ cards: 12 - body.cards.length });
    expect(body.cards.map((c) => c.number)).toEqual(
      newestFirst.slice(0, body.cards.length)
    );
    expect(body.has_more).toBe(true);
    expect(contentText(cut)).toContain(
      'NOTE: this result was held to 4,000 characters'
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
        expect(page.fit).toMatchObject({ budget: 4_000, source: 'session' });
      }
      expect(contentText(next).length).toBeLessThanOrEqual(4_000);
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
          .contains('metadata', { tool: 'board', reported: 4_000 })
          .gte('occurred_at', since);
        expect(error).toBeNull();
        return (data ?? []).map((row) => row.metadata);
      })
      .toContainEqual(
        expect.objectContaining({
          budget: 4_000,
          source: 'call',
          omitted: { cards: 12 - body.cards.length },
        })
      );
  } finally {
    await mcp.close();
  }
});

test("a card read over the reported limit keeps the card's text and attachments, and its history pages on", async () => {
  const seed = await readSeedState();
  const mcp = await McpTestClient.connect(await passwordGrantToken(seed.userA));
  try {
    const { scope } = await boardWith(mcp, 'card', 0, () => '');
    const created = firstJson<{ card: { id: string; number: number } }>(
      await mcp.callTool('card', {
        action: 'create',
        scope,
        title: 'Fit a long history',
        body: `The goal. ${'b'.repeat(1_000)}`,
        type: 'task',
        no_links: 'e2e fixture',
      })
    ).card;
    for (const url of ['https://example.com/one', 'https://example.com/two']) {
      const attached = await mcp.callTool('card_log', {
        action: 'attach',
        card_id: created.id,
        ref_kind: 'url',
        ref_target: url,
      });
      expect(attached.isError ?? false).toBe(false);
    }
    for (let i = 0; i < 8; i += 1) {
      const noted = await mcp.callTool('card_log', {
        action: 'note',
        card_id: created.id,
        text: `Step ${i}: ${'n'.repeat(500)}`,
      });
      expect(noted.isError ?? false).toBe(false);
    }

    interface CardRead {
      card: { body: string };
      refs: unknown[];
      events: Array<{ seq: number }>;
      has_more: boolean;
      next_after_seq: number;
      fit?: Page['fit'];
    }
    const read = async (args: Record<string, unknown>): Promise<CardRead> => {
      const result = await mcp.callTool('board', {
        action: 'get',
        card_id: created.id,
        ...args,
      });
      expect(result.isError ?? false).toBe(false);
      return firstJson<CardRead>(result);
    };

    // The whole history, read before any limit was reported.
    const whole = await read({});
    expect(whole.fit).toBeUndefined();
    const allSeqs = whole.events.map((e) => e.seq);
    expect(allSeqs.length).toBeGreaterThanOrEqual(10);

    const cut = await read({ max_chars: 4_000 });
    expect(cut.fit?.omitted.events).toBeGreaterThan(0);
    // No cursor reaches past them, so the text and the attachments stay whole.
    expect(cut.card.body).toBe(whole.card.body);
    expect(cut.refs).toHaveLength(2);
    expect(cut.has_more).toBe(true);
    expect(cut.next_after_seq).toBe(cut.events.at(-1)?.seq);

    // Paging on from the last event delivered reaches every event once.
    const seqs = cut.events.map((e) => e.seq);
    let after = cut.next_after_seq;
    let more = cut.has_more;
    while (more) {
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
        max_chars: 8_000,
      })
    );
    expect(resolved.fit).toMatchObject({ budget: 8_000, source: 'call' });
  } finally {
    await mcp.close();
  }
});
