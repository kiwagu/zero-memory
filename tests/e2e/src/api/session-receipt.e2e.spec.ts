/**
 * Session receipt end-to-end: the `session_receipt` tool aggregates what a
 * session window produced — recalled facts that actually fired (recall_used),
 * open-loop churn, and the briefing saved-tokens estimate — from rows that
 * already exist. The window is honest: a `since` after the activity returns
 * zeros, so the end-of-session receipt can never re-bill an earlier session.
 */
import { expect, test } from '@playwright/test';

import { readSeedState } from '../helpers/runtime-state.js';
import { firstJson, McpTestClient } from '../helpers/mcp.js';
import { passwordGrantToken } from '../helpers/users.js';

interface Receipt {
  fired: number;
  loops_created: number;
  loops_closed: number;
  saved_tokens: number;
  since: string | null;
}

test.describe('Session receipt over MCP @smoke', () => {
  test('counts fired recalls and loop churn since the window start, zeros after it', async () => {
    const seed = await readSeedState();
    // User B: the loop/supersede churn here must not shift user A's recall
    // pool while the parity specs compare sequential A-recalls.
    const mcp = await McpTestClient.connect(
      await passwordGrantToken(seed.userB)
    );
    try {
      // Window start BEFORE the session's activity (1s of clock-skew slack).
      const since = new Date(Date.now() - 1000).toISOString();

      // A recalled fact is USED: a remember that supersedes it emits the
      // in-band recall_used event the receipt counts as "fired".
      const base = await mcp.callTool('remember', {
        content: 'e2e receipt marker: the export job runs nightly at 02:00 UTC',
        kind: 'fact',
        scope: 'personal',
      });
      expect(base.isError ?? false).toBe(false);
      const baseId = firstJson<{ memory_id: string }>(base).memory_id;

      const superseding = await mcp.callTool('remember', {
        content:
          'e2e receipt marker: the export job moved to hourly incremental runs',
        kind: 'fact',
        links: [{ type: 'supersedes', dst: baseId }],
        scope: 'personal',
      });
      expect(superseding.isError ?? false).toBe(false);

      // Loop churn: one task born in the window, then closed in the window.
      const loop = await mcp.callTool('remember', {
        content:
          'e2e receipt marker: verify the nightly export after the schedule ' +
          'change ships',
        kind: 'task',
        scope: 'personal',
      });
      expect(loop.isError ?? false).toBe(false);
      const loopId = firstJson<{ memory_id: string }>(loop).memory_id;
      const closed = await mcp.callTool('close_loop', { memory_id: loopId });
      expect(closed.isError ?? false).toBe(false);

      const receipt = firstJson<Receipt>(
        await mcp.callTool('session_receipt', { since })
      );
      expect(receipt.fired).toBeGreaterThanOrEqual(1);
      expect(receipt.loops_created).toBeGreaterThanOrEqual(1);
      expect(receipt.loops_closed).toBeGreaterThanOrEqual(1);
      expect(receipt.saved_tokens).toBeGreaterThanOrEqual(0);
      expect(receipt.since).not.toBeNull();

      // Honest window: a since AFTER the activity sees none of it.
      const after = firstJson<Receipt>(
        await mcp.callTool('session_receipt', {
          since: new Date(Date.now() + 1000).toISOString(),
        })
      );
      expect(after.fired).toBe(0);
      expect(after.loops_created).toBe(0);
      expect(after.loops_closed).toBe(0);
      expect(after.saved_tokens).toBe(0);
    } finally {
      await mcp.close();
    }
  });

  test('a briefing feeds the saved-tokens estimate into the receipt window', async () => {
    const seed = await readSeedState();
    const mcp = await McpTestClient.connect(
      await passwordGrantToken(seed.userA)
    );
    try {
      const since = new Date(Date.now() - 1000).toISOString();

      // A briefing build_context emits session_briefing tokens; user A has
      // seeded fixture memories, so the pack (and its estimate) is non-empty.
      const briefing = await mcp.callTool('build_context', {
        topic: 'e2e fixture dashboard',
        briefing: true,
      });
      expect(briefing.isError ?? false).toBe(false);

      const receipt = firstJson<Receipt>(
        await mcp.callTool('session_receipt', { since })
      );
      expect(receipt.saved_tokens).toBeGreaterThan(0);
    } finally {
      await mcp.close();
    }
  });
});
