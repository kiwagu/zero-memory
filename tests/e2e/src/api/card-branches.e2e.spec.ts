/**
 * Card branches through the tools an agent calls: work names its branch when
 * it enters active, lands it when it leaves, and the card reads back where
 * its code ran. The same rules the store enforces reach the agent as a
 * sentence it can act on.
 */
import { expect, test } from '@playwright/test';

import { contentText, firstJson, McpTestClient } from '../helpers/mcp.js';
import { readSeedState } from '../helpers/runtime-state.js';
import { passwordGrantToken } from '../helpers/users.js';

const REPO = 'acme/memory-service';

interface CardResult {
  card: { id: string; number: number; scope: string; state: string };
  changed: boolean;
}

interface BoardGet {
  card: { state: string } | null;
  branches: Array<{
    repo: string;
    branch: string;
    state: string;
    squash_sha: string | null;
    target: string | null;
    landings?: Array<{
      squash_sha: string;
      target: string | null;
      landed_at: string;
    }>;
  }>;
  events: Array<{
    type: string;
    branch_note: string | null;
    squash_sha: string | null;
    target_branch: string | null;
    ref_target: string | null;
  }>;
}

test.describe('Card branches over MCP', () => {
  test('work names its branch entering active and lands it leaving', async () => {
    const seed = await readSeedState();
    const agent = await McpTestClient.connect(
      await passwordGrantToken(seed.userA)
    );
    try {
      const loop = firstJson<{ memory_id: string; scope: string }>(
        await agent.callTool('remember', {
          content: `e2e branch flow marker ${Date.now()}: move the ingest worker to the new queue`,
          kind: 'task',
          project_hint: '/tmp/zm-e2e-branch-flow',
        })
      );

      const bare = await agent.callTool('card', {
        action: 'promote_loop',
        no_links: 'e2e fixture',
        loop_id: loop.memory_id,
        title: 'Move the ingest worker',
      });
      expect(bare.isError ?? false).toBe(true);
      expect(contentText(bare)).toMatch(/branch/u);

      const promoted = await agent.callTool('card', {
        action: 'promote_loop',
        no_links: 'e2e fixture',
        loop_id: loop.memory_id,
        title: 'Move the ingest worker',
        branch: { repo: REPO, name: 'feature/ingest-queue' },
      });
      expect(promoted.isError ?? false).toBe(false);
      const card = firstJson<CardResult>(promoted).card;
      expect(card.state).toBe('active');

      const blocked = await agent.callTool('card', {
        action: 'move',
        card_id: card.id,
        to: 'waiting',
        reason: 'finished from my side',
      });
      expect(blocked.isError ?? false).toBe(true);
      expect(contentText(blocked)).toContain(`${REPO}:feature/ingest-queue`);
      expect(contentText(blocked)).toMatch(/land/u);

      const landed = await agent.callTool('card', {
        action: 'land',
        card_id: card.id,
        branch: { repo: REPO, name: 'feature/ingest-queue' },
        squash_sha: 'ABCDEF1',
        target: 'main',
        reason: 'full e2e green; waits for the release',
      });
      expect(landed.isError ?? false).toBe(false);
      expect(firstJson<CardResult>(landed).card.state).toBe('waiting');

      const again = await agent.callTool('card', {
        action: 'land',
        card_id: card.id,
        branch: { repo: REPO, name: 'feature/ingest-queue' },
        squash_sha: 'abcdef1234567890',
        target: 'main',
        reason: 'retry after a timeout',
      });
      expect(firstJson<CardResult>(again).changed).toBe(false);

      const read = firstJson<BoardGet>(
        await agent.callTool('board', { action: 'get', card_id: card.id })
      );
      expect(read.branches).toEqual([
        expect.objectContaining({
          repo: REPO,
          branch: 'feature/ingest-queue',
          state: 'landed',
          squash_sha: 'abcdef1',
          target: 'main',
        }),
      ]);
      expect(
        read.events.find((event) => event.type === 'landed')
      ).toMatchObject({
        ref_target: `${REPO}:feature/ingest-queue`,
        squash_sha: 'abcdef1',
        target_branch: 'main',
      });

      // A bug fixed in the same branch lands it again, and the card reads
      // back every landing, not only the last.
      const relanded = await agent.callTool('card', {
        action: 'land',
        card_id: card.id,
        branch: { repo: REPO, name: 'feature/ingest-queue' },
        squash_sha: 'bbbbbbb',
        target: 'main',
        reason: 'a bug fixed in the same branch',
      });
      expect(firstJson<CardResult>(relanded).changed).toBe(true);
      const reread = firstJson<BoardGet>(
        await agent.callTool('board', { action: 'get', card_id: card.id })
      );
      expect(
        reread.branches[0]?.landings?.map((landing) => landing.squash_sha)
      ).toEqual(['abcdef1', 'bbbbbbb']);
    } finally {
      await agent.close();
    }
  });

  test('a stated reason stands in for a branch, and is kept on the record', async () => {
    const seed = await readSeedState();
    const agent = await McpTestClient.connect(
      await passwordGrantToken(seed.userA)
    );
    try {
      const scope = firstJson<{ scope: string }>(
        await agent.callTool('remember', {
          content: `e2e branch declaration marker ${Date.now()}: the recall gap needs a measurement`,
          kind: 'fact',
          project_hint: '/tmp/zm-e2e-branch-declare',
        })
      ).scope;
      const created = firstJson<CardResult>(
        await agent.callTool('card', {
          action: 'create',
          no_links: 'e2e fixture',
          scope,
          title: 'Measure the recall gap',
        })
      ).card;

      const declared = await agent.callTool('card', {
        action: 'move',
        card_id: created.id,
        to: 'active',
        reason: 'starting the measurement',
        no_branch: 'a measurement on the review stand; no code',
      });
      expect(declared.isError ?? false).toBe(false);

      const attached = await agent.callTool('card_log', {
        action: 'attach',
        card_id: created.id,
        ref_kind: 'branch',
        ref_target: `${REPO}:spike/recall-probe`,
      });
      expect(attached.isError ?? false).toBe(false);

      const leave = await agent.callTool('card', {
        action: 'move',
        card_id: created.id,
        to: 'parked',
        reason: 'the stand is busy',
        not_landed: 'the probe branch is a throwaway; it never lands',
      });
      expect(leave.isError ?? false).toBe(false);

      const read = firstJson<BoardGet>(
        await agent.callTool('board', { action: 'get', card_id: created.id })
      );
      const notes = read.events
        .map((event) => event.branch_note)
        .filter(Boolean);
      expect(notes).toEqual([
        'a measurement on the review stand; no code',
        'the probe branch is a throwaway; it never lands',
      ]);
      expect(read.branches).toEqual([
        expect.objectContaining({
          branch: 'spike/recall-probe',
          state: 'open',
        }),
      ]);
    } finally {
      await agent.close();
    }
  });
});
