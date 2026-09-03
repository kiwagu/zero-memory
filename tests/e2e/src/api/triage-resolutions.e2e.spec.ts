/**
 * Agent-triage bulk resolution: resolve_conflicts with an explicit
 * `resolutions` list settles queued conflicts in one call (keep_both when no
 * winner is named), reports per-item failures instead of aborting, and
 * refuses the ambiguous both-modes call.
 */
import { expect, test } from '@playwright/test';

import { seedReviewConflict } from '../helpers/review.js';
import { readSeedState } from '../helpers/runtime-state.js';
import { contentText, firstJson, McpTestClient } from '../helpers/mcp.js';
import { passwordGrantToken } from '../helpers/users.js';

interface TriageResult {
  resolved: number;
  failed: Array<{ dispute_id: string; error: string }>;
}

test.describe('resolve_conflicts triage mode over MCP', () => {
  test('an explicit resolutions list settles the conflict in one call; a re-submit reports failed, not throws', async () => {
    const seed = await readSeedState();
    const conflict = await seedReviewConflict(seed.userB);
    const mcp = await McpTestClient.connect(
      await passwordGrantToken(seed.userB)
    );
    try {
      const first = await mcp.callTool('resolve_conflicts', {
        resolutions: [{ dispute_id: conflict.queueId }],
      });
      expect(first.isError ?? false).toBe(false);
      const settled = firstJson<TriageResult>(first);
      expect(settled.resolved).toBe(1);
      expect(settled.failed).toEqual([]);

      // Same id again: the row is no longer pending — reported per-item.
      const again = await mcp.callTool('resolve_conflicts', {
        resolutions: [{ dispute_id: conflict.queueId }],
      });
      expect(again.isError ?? false).toBe(false);
      const reported = firstJson<TriageResult>(again);
      expect(reported.resolved).toBe(0);
      expect(reported.failed).toHaveLength(1);
      expect(reported.failed[0]!.dispute_id).toBe(conflict.queueId);
    } finally {
      await mcp.close();
    }
  });

  test('passing both a policy and a resolutions list is refused', async () => {
    const seed = await readSeedState();
    const mcp = await McpTestClient.connect(
      await passwordGrantToken(seed.userB)
    );
    try {
      const refused = await mcp.callTool('resolve_conflicts', {
        policy: 'keep_both',
        resolutions: [{ dispute_id: 'mrq_0000000000000000.0000000000' }],
      });
      expect(refused.isError ?? false).toBe(true);
      expect(contentText(refused)).toContain('exactly one mode');
    } finally {
      await mcp.close();
    }
  });
});
