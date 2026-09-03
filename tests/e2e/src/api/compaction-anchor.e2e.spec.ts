/**
 * The server contract behind the compaction anchor.
 *
 * When a client's context is about to be compacted, its hook has one chance to
 * tell the summarizing model what must survive — and only a few seconds to
 * assemble it. So the anchor makes ONE ordinary `build_context` call and reads
 * both halves it needs off the result: the open loops, and which project and
 * conversation the work belongs to.
 *
 * Two properties of that call are load-bearing and invisible from the client's
 * own tests, which is why they are pinned here. The call deliberately does NOT
 * set `briefing: true` — that flag meters a call as a briefing delivered to an
 * agent, and a hook firing at a compaction is not one; counting it would inflate
 * the very number the briefing metrics exist to report. And it asks for a small
 * budget, because it discards the ranked pack entirely. If loops ever became
 * conditional on either of those, every anchor would quietly ship empty while
 * the client's unit tests stayed green.
 */
import { expect, test } from '@playwright/test';

import { firstJson, McpTestClient } from '../helpers/mcp.js';
import { passwordGrantToken, provisionE2EUser } from '../helpers/users.js';

interface AnchorSource {
  open_loops: Array<{ id: string; kind: string; content: string }>;
  open_loops_total: number;
  project_scope?: string;
  session?: { attached_project: string | null; thread?: string };
}

const PROJECT_HINT = '/home/someone/repos/harbour-dredging-e2e';

test.describe('Compaction anchor source over MCP', () => {
  test('one call with no briefing flag carries both halves the anchor needs', async () => {
    const user = await provisionE2EUser('compaction-anchor@zm.e2e');
    const mcp = await McpTestClient.connect(await passwordGrantToken(user));
    try {
      const remembered = await mcp.callTool('remember', {
        content:
          'e2e compaction-anchor marker: confirm the dredging window with ' +
          'the harbour master before booking the barge',
        kind: 'task',
        project_hint: PROJECT_HINT,
      });
      expect(remembered.isError ?? false).toBe(false);
      const { memory_id } = firstJson<{ memory_id: string }>(remembered);

      // The anchor's dialect: a conversation id (the hook always has one), a
      // project hint, a small budget — and NO briefing flag.
      const pack = firstJson<AnchorSource>(
        await mcp.callTool('build_context', {
          topic: 'harbour-dredging-e2e',
          conversation_id: 'e2e-compaction-anchor-session',
          project_hint: PROJECT_HINT,
          max_tokens: 400,
        })
      );

      // Half one — what the summary must not drop.
      expect(
        pack.open_loops.map((loop) => loop.id),
        'an unbriefed call must still carry the open loops'
      ).toContain(memory_id);
      expect(pack.open_loops_total).toBeGreaterThanOrEqual(1);

      // Half two — who this work belongs to. The transcript cannot rebuild
      // either value once it has been condensed away.
      expect(pack.session?.thread).toMatch(/^thr_/u);
      expect(pack.project_scope).toBeTruthy();

      await mcp.callTool('close_loop', { memory_id });
    } finally {
      await mcp.close();
    }
  });

  test('a budget small enough to drop the pack still carries the loops', async () => {
    // The anchor asks for almost no pack on purpose: it re-delivers no
    // memories, and every character it spends competes with the conversation
    // being summarized. That trade only holds while loops are assembled
    // independently of the ranked legs.
    const user = await provisionE2EUser('compaction-anchor-budget@zm.e2e');
    const mcp = await McpTestClient.connect(await passwordGrantToken(user));
    try {
      const remembered = await mcp.callTool('remember', {
        content:
          'e2e compaction-anchor marker: the spoil-ground survey is still ' +
          'waiting on the tide tables for next quarter',
        kind: 'open-question',
        project_hint: PROJECT_HINT,
      });
      expect(remembered.isError ?? false).toBe(false);
      const { memory_id } = firstJson<{ memory_id: string }>(remembered);

      const pack = firstJson<AnchorSource>(
        await mcp.callTool('build_context', {
          topic: 'something entirely unrelated to dredging',
          conversation_id: 'e2e-compaction-anchor-budget-session',
          project_hint: PROJECT_HINT,
          max_tokens: 400,
        })
      );

      expect(pack.open_loops.map((loop) => loop.id)).toContain(memory_id);

      await mcp.callTool('close_loop', { memory_id });
    } finally {
      await mcp.close();
    }
  });
});
