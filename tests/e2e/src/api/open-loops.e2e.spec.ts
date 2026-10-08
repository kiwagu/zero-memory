/**
 * Open loops end-to-end: a task handed over from one session ("machine A")
 * surfaces in another session's briefing ("machine B") above the ranked pack,
 * disappears from briefings once closed with close_loop, and stays in
 * history (ADD-only). The content guard applies to loop kinds like any write.
 */
import { expect, test } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';

import { backdateMemory } from '../helpers/decay.js';
import { e2eEnv } from '../helpers/env.js';
import { readSeedState } from '../helpers/runtime-state.js';
import { contentText, firstJson, McpTestClient } from '../helpers/mcp.js';
import { passwordGrantToken, provisionE2EUser } from '../helpers/users.js';

interface BriefingPack {
  memories: Array<{ id: string }>;
  linked_memories: Array<{ id: string }>;
  open_loops: Array<{ id: string; kind: string; content: string }>;
  open_loops_total: number;
  open_loops_aged: number;
}

interface RememberResult {
  memory_id: string;
  scope: string;
  status_hint?: string;
}

test.describe('Open loops over MCP', () => {
  test('a task from machine A surfaces in machine B briefings until closed, then stays in history', async () => {
    const seed = await readSeedState();
    const token = await passwordGrantToken(seed.userA);
    // Two independent MCP sessions of the same owner: the sender (machine A)
    // and the receiver (machine B) of the inter-machine buffer.
    const machineA = await McpTestClient.connect(token);
    const machineB = await McpTestClient.connect(token);
    try {
      const remembered = await machineA.callTool('remember', {
        content:
          'e2e open-loop marker: check the watcher warnings on the stage ' +
          'machine — log pointer /shares/zm/watcher-stage.log, look for ' +
          'repeated oauth refresh failures',
        kind: 'task',
        scope: 'personal',
      });
      expect(remembered.isError ?? false).toBe(false);
      const { memory_id } = firstJson<{ memory_id: string }>(remembered);

      // The receiving machine briefs on an UNRELATED topic: the loop must
      // surface anyway (open loops are lifecycle, not relevance).
      const briefing = await machineB.callTool('build_context', {
        topic: 'dashboard feed pagination',
      });
      expect(briefing.isError ?? false).toBe(false);
      const pack = firstJson<BriefingPack>(briefing);
      const loop = pack.open_loops.find((entry) => entry.id === memory_id);
      expect(
        loop,
        'active task must be in the open_loops section'
      ).toBeTruthy();
      expect(loop!.kind).toBe('task');
      expect(pack.open_loops_total).toBeGreaterThanOrEqual(1);
      // ...and never duplicated into the ranked legs.
      expect(
        [...pack.memories, ...pack.linked_memories].map((m) => m.id)
      ).not.toContain(memory_id);

      // The receiving machine completes the work and closes the loop.
      const closed = await machineB.callTool('close_loop', { memory_id });
      expect(closed.isError ?? false).toBe(false);
      expect(firstJson<{ closed: boolean }>(closed).closed).toBe(true);

      const after = firstJson<BriefingPack>(
        await machineB.callTool('build_context', {
          topic: 'dashboard feed pagination',
        })
      );
      expect(after.open_loops.map((entry) => entry.id)).not.toContain(
        memory_id
      );

      // Double-closing is a clean error, not a silent no-op.
      const again = await machineB.callTool('close_loop', { memory_id });
      expect(again.isError ?? false).toBe(true);

      // ADD-only history: the closed loop still exists (restore revives it),
      // it was never deleted. Re-close to leave the stack clean.
      const restored = await machineA.callTool('restore_memory', { memory_id });
      expect(restored.isError ?? false).toBe(false);
      expect(firstJson<{ restored: boolean }>(restored).restored).toBe(true);
      const reclose = await machineA.callTool('close_loop', { memory_id });
      expect(reclose.isError ?? false).toBe(false);
    } finally {
      await machineA.close();
      await machineB.close();
    }
  });

  test('an open-question surfaces and closes the same way', async () => {
    const seed = await readSeedState();
    const mcp = await McpTestClient.connect(
      await passwordGrantToken(seed.userA)
    );
    try {
      const remembered = await mcp.callTool('remember', {
        content:
          'e2e open-loop marker: should the ingest retry budget stay at 3 ' +
          'attempts once the queue moves to pgmq?',
        kind: 'open-question',
        scope: 'personal',
      });
      expect(remembered.isError ?? false).toBe(false);
      const { memory_id } = firstJson<{ memory_id: string }>(remembered);

      const pack = firstJson<BriefingPack>(
        await mcp.callTool('build_context', { topic: 'anything else entirely' })
      );
      const loop = pack.open_loops.find((entry) => entry.id === memory_id);
      expect(loop?.kind).toBe('open-question');

      const closed = await mcp.callTool('close_loop', { memory_id });
      expect(closed.isError ?? false).toBe(false);
    } finally {
      await mcp.close();
    }
  });

  test('a loop past the soft TTL leaves the list but is counted until a card carries it', async () => {
    // A dedicated user, so the count of aged loops is exact: the seed users'
    // corpora grow under concurrent specs, and a write here must not shift
    // user A's recall pool while the parity specs compare two sequential
    // A-recalls for id equality.
    const user = await provisionE2EUser('aged-loop@zm.e2e');
    const mcp = await McpTestClient.connect(await passwordGrantToken(user));
    const briefAged = async (): Promise<BriefingPack> =>
      firstJson<BriefingPack>(
        await mcp.callTool('build_context', { topic: 'unrelated topic probe' })
      );
    try {
      const remembered = await mcp.callTool('remember', {
        content:
          'e2e open-loop marker: soft-ttl probe — revisit the quokka export ' +
          'once the batch importer stabilizes',
        kind: 'task',
        scope: 'personal',
      });
      expect(remembered.isError ?? false).toBe(false);
      const { memory_id } = firstJson<{ memory_id: string }>(remembered);

      // Inside the window it is listed, and nothing is aged yet.
      const fresh = await briefAged();
      expect(fresh.open_loops.map((entry) => entry.id)).toContain(memory_id);
      expect(fresh.open_loops_aged).toBe(0);

      // Age the unclosed loop past the default 14-day briefing window.
      await backdateMemory(memory_id, 20);

      // Gone from the briefing section (and from its "N more" count basis),
      // but counted, so the briefing can say it exists instead of hiding it.
      const pack = await briefAged();
      expect(pack.open_loops.map((entry) => entry.id)).not.toContain(memory_id);
      expect(pack.open_loops_total).toBe(0);
      expect(pack.open_loops_aged).toBe(1);

      // …but soft: still an ACTIVE memory a direct recall finds — the TTL
      // demotes the nag, it never closes or hides the loop itself.
      const recalled = await mcp.callTool('recall', {
        query: 'quokka export batch importer',
        k: 10,
        kinds: ['task'],
      });
      expect(recalled.isError ?? false).toBe(false);
      expect(contentText(recalled)).toContain(memory_id);

      // A loop a card carries is reached through the board: no longer counted.
      const promoted = await mcp.callTool('card', {
        action: 'promote_loop',
        loop_id: memory_id,
        no_links: 'e2e fixture',
        title: 'Revisit the quokka export',
        state: 'idea',
        type: 'task',
      });
      expect(promoted.isError ?? false, contentText(promoted)).toBe(false);
      const card = firstJson<{ card: { id: string } }>(promoted).card;
      expect((await briefAged()).open_loops_aged).toBe(0);

      // An archived card is no home: the loop counts again.
      const archived = await mcp.callTool('card', {
        action: 'archive',
        card_id: card.id,
        reason: 'e2e fixture cleanup',
      });
      expect(archived.isError ?? false).toBe(false);
      expect((await briefAged()).open_loops_aged).toBe(1);

      // Closing still works on an aged-out loop. Leave the stack clean.
      const closed = await mcp.callTool('close_loop', { memory_id });
      expect(closed.isError ?? false).toBe(false);
      expect((await briefAged()).open_loops_aged).toBe(0);
    } finally {
      await mcp.close();
    }
  });

  test('re-cutting a task loop points the writer at the card the conversation is bound to', async () => {
    const seed = await readSeedState();
    const agent = await McpTestClient.connect(
      await passwordGrantToken(seed.userA)
    );
    // A fresh project per run, so no earlier run's loops or cards interfere.
    const hint = `/tmp/zm-e2e-loop-status-${Date.now()}`;
    const remember = async (
      args: Record<string, unknown>,
      supersedes?: string
    ): Promise<RememberResult> => {
      const stored = await agent.callTool('remember', {
        project_hint: hint,
        ...args,
        ...(supersedes
          ? { links: [{ type: 'supersedes', dst: supersedes }] }
          : {}),
      });
      expect(stored.isError ?? false).toBe(false);
      return firstJson<RememberResult>(stored);
    };
    try {
      // Reading first opens the conversation this agent's writes are born in.
      const pack = firstJson<{ session?: { thread?: string } }>(
        await agent.callTool('build_context', {
          topic: 'importer retries',
          briefing: true,
          project_hint: hint,
        })
      );
      const thread = pack.session?.thread;
      expect(thread).toMatch(/^thr_/u);

      // A first cut is a handover like any other: no hint.
      const first = await remember({
        content:
          'e2e loop-status marker: the importer branch has the retry wrapper; ' +
          'next, wire the exponential backoff into the nightly job',
        kind: 'task',
      });
      expect(first.status_hint).toBeUndefined();

      // Re-cut with no card bound: the hint says to put the work on one.
      const second = await remember(
        {
          content:
            'e2e loop-status marker: backoff is wired into the nightly job ' +
            'and passes locally; next, cap the attempts and log each retry',
          kind: 'task',
        },
        first.memory_id
      );
      expect(second.status_hint).toContain('cut 2');
      expect(second.status_hint).toContain('card promote_loop');

      // Bound to a card, the next re-cut names it and counts the whole chain.
      const created = await agent.callTool('card', {
        action: 'create',
        no_links: 'e2e fixture',
        scope: first.scope,
        title: 'Importer retries survive a flaky upstream',
        type: 'task',
      });
      expect(created.isError ?? false).toBe(false);
      const card = firstJson<{ card: { id: string; number: number } }>(
        created
      ).card;
      const bound = await agent.callTool('card_log', {
        action: 'attach',
        card_id: card.id,
        ref_kind: 'thread',
        ref_target: thread,
      });
      expect(bound.isError ?? false).toBe(false);
      const third = await remember(
        {
          content:
            'e2e loop-status marker: attempts are capped at five with a log ' +
            'line per retry; next, document the knob in the operator runbook',
          kind: 'task',
        },
        second.memory_id
      );
      expect(third.status_hint).toContain('cut 3');
      expect(third.status_hint).toContain(
        `\`card_log note\` on ZM-${card.number}`
      );

      // A question re-cut adds evidence, not status: no hint.
      const asked = await remember({
        content:
          'e2e loop-status marker: does the upstream honour Retry-After on ' +
          'a 503, or only on a 429?',
        kind: 'open-question',
      });
      const reasked = await remember(
        {
          content:
            'e2e loop-status marker: seen twice now, the upstream ignores ' +
            'Retry-After on a 503; does it honour it on a 429 at least?',
          kind: 'open-question',
        },
        asked.memory_id
      );
      expect(reasked.status_hint).toBeUndefined();

      // Leave the stack clean.
      for (const memory_id of [third.memory_id, reasked.memory_id]) {
        const closed = await agent.callTool('close_loop', { memory_id });
        expect(closed.isError ?? false).toBe(false);
      }
    } finally {
      await agent.close();
    }
  });

  test('a loop a person reopens is not closed again on the evidence they overruled', async () => {
    // A dedicated user: the closure rollup reads every newer memory of the
    // owner, and the seed users' corpora grow under concurrent specs.
    const user = await provisionE2EUser('reopened-loop@zm.e2e');
    const token = await passwordGrantToken(user);
    const agent = await McpTestClient.connect(token);
    // Completion evidence comes from other conversations, so no same-session
    // rule folds it into the loop or into each other.
    const reporter = await McpTestClient.connect(token);
    const later = await McpTestClient.connect(token);
    const admin = createClient(
      e2eEnv.supabaseUrl,
      e2eEnv.supabaseServiceRoleKey,
      { auth: { persistSession: false } }
    );
    const stamp = Date.now();
    const remember = async (
      client: McpTestClient,
      content: string,
      kind: string
    ) => {
      const stored = await client.callTool('remember', {
        content,
        kind,
        scope: 'personal',
      });
      expect(stored.isError ?? false).toBe(false);
      return firstJson<{ memory_id: string }>(stored).memory_id;
    };
    // What the judge would be shown next: the newest evidence the rollup
    // pairs with the loop, at the detector's own similarity floor.
    const newestEvidence = async (loopId: string) => {
      const { data: owner } = await admin
        .from('memories')
        .select('owner_id')
        .eq('id', loopId)
        .single();
      const { data, error } = await admin.rpc('find_loop_closure_evidence', {
        p_owner: owner?.owner_id,
      });
      expect(error).toBeNull();
      return (
        data as Array<{ loop_id: string; newest_evidence_id: string }>
      ).find((row) => row.loop_id === loopId)?.newest_evidence_id;
    };
    const guard = async (loopId: string) => {
      const { data } = await admin
        .from('loop_closure_checks')
        .select('last_evidence_id')
        .eq('loop_id', loopId)
        .maybeSingle();
      return data?.last_evidence_id ?? null;
    };

    try {
      const loop = await remember(
        agent,
        `e2e reopen marker ${stamp}: migrate the invoice archive to cold storage — copy, verify and delete the hot copies`,
        'task'
      );
      const done = await remember(
        reporter,
        `e2e reopen marker ${stamp}: the invoice archive migration to cold storage is finished`,
        'fact'
      );
      expect(await newestEvidence(loop)).toBe(done);

      // The loop is closed. The closure judge's own close deletes its guard
      // too, so either way the loop has none when it comes back.
      const closed = await agent.callTool('close_loop', { memory_id: loop });
      expect(closed.isError ?? false).toBe(false);
      expect(await guard(loop)).toBeNull();

      // The owner says it is not done and reopens it.
      const restored = await agent.callTool('restore_memory', {
        memory_id: loop,
      });
      expect(restored.isError ?? false).toBe(false);

      // THE CLAIM: the reopened loop is held against the evidence it already
      // has. A guard equal to the newest evidence is exactly what makes the
      // next detector run skip the loop instead of judging it again.
      expect(await guard(loop)).toBe(done);
      expect(await newestEvidence(loop)).toBe(done);

      // Newer evidence is what earns the loop another judgement.
      const followUp = await remember(
        later,
        `e2e reopen marker ${stamp}: the hot copies of the invoice archive are deleted, cold storage verified`,
        'fact'
      );
      expect(await newestEvidence(loop)).toBe(followUp);
      expect(await guard(loop)).toBe(done);
    } finally {
      await agent.close();
      await reporter.close();
      await later.close();
    }
  });
});
