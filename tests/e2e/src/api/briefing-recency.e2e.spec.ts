/**
 * Recency leg end-to-end: a briefing (briefing: true) carries `recent[]` —
 * the scope's fresh decisions independent of topic similarity — deduplicated
 * against the ranked legs; a mid-session build_context does not. Memories
 * promoted into the rules layer stay out of a briefing entirely (they are
 * delivered by the rules file already) while remaining directly recallable.
 *
 * Isolated user: fixtures write decisions and a promoted rule_candidates
 * row, which must not shift the shared seed users' pools.
 */
import { expect, test } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';

import { backdateMemory } from '../helpers/decay.js';
import { e2eEnv } from '../helpers/env.js';
import { contentText, firstJson, McpTestClient } from '../helpers/mcp.js';
import { passwordGrantToken, provisionE2EUser } from '../helpers/users.js';

const adminClient = () =>
  createClient(e2eEnv.supabaseUrl, e2eEnv.supabaseServiceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

interface BriefingPack {
  memories: Array<{ id: string }>;
  linked_memories: Array<{ id: string }>;
  recent?: Array<{ id: string; kind: string }>;
}

test.describe('Briefing recency leg over MCP', () => {
  test('a week-old decision reaches a generic-topic briefing via recent[], but not a mid-session call', async () => {
    const user = await provisionE2EUser('briefing-recency@zm.e2e');
    const mcp = await McpTestClient.connect(await passwordGrantToken(user));
    try {
      const remembered = await mcp.callTool('remember', {
        content:
          'chose cursor-based pagination for the export feed because offset ' +
          'scans degraded past one million rows',
        kind: 'decision',
        scope: 'personal',
      });
      expect(remembered.isError ?? false).toBe(false);
      const { memory_id } = firstJson<{ memory_id: string }>(remembered);
      // A week old: inside the 14-day recency window, but old enough to
      // prove the leg is not just echoing this second's writes.
      await backdateMemory(memory_id, 7);

      // Generic topic, deliberately unrelated to the decision's content.
      const briefing = firstJson<BriefingPack>(
        await mcp.callTool('build_context', {
          topic: 'team knowledge base overview',
          briefing: true,
        })
      );
      const ranked = [...briefing.memories, ...briefing.linked_memories].map(
        (memory) => memory.id
      );
      if (!ranked.includes(memory_id)) {
        expect(
          (briefing.recent ?? []).map((memory) => memory.id),
          'a fresh decision must reach the briefing through recent[]'
        ).toContain(memory_id);
      }

      // The mid-session call (no briefing flag) has no recency leg.
      const midSession = firstJson<BriefingPack>(
        await mcp.callTool('build_context', {
          topic: 'team knowledge base overview',
        })
      );
      expect(midSession.recent ?? []).toEqual([]);
    } finally {
      await mcp.close();
    }
  });

  test('recent[] keeps personal memories but drops a foreign project scope when no project is pinned', async () => {
    // A dedicated isolated user so the corpus is exactly what this spec seeds.
    const user = await provisionE2EUser('briefing-recency-scope@zm.e2e');
    const mcp = await McpTestClient.connect(await passwordGrantToken(user));
    try {
      // Fill the ranked top-k with decoys that strongly match the briefing
      // topic, so the two target memories below — deliberately unrelated to
      // the topic — fall OUTSIDE search_memories' top hits and can only reach
      // the pack through the relevance-free recency leg. (Without this, a
      // tiny corpus makes every memory a ranked hit and recency dedups to
      // empty.) Each decoy is a distinct sentence sharing the topic tokens so
      // the near-duplicate probe keeps them as separate rows.
      const decoyContents = [
        'quarterly board reporting metrics dashboard: add a revenue-retention cohort tile',
        'quarterly board reporting metrics dashboard: p99 latency belongs beside the mean',
        'quarterly board reporting metrics dashboard: churn must be net of reactivations',
        'quarterly board reporting metrics dashboard: gross margin needs a per-plan split',
        'quarterly board reporting metrics dashboard: pipeline coverage as a leading signal',
        'quarterly board reporting metrics dashboard: headcount ratio against ARR per seat',
        'quarterly board reporting metrics dashboard: cash runway on the summary header',
        'quarterly board reporting metrics dashboard: NRR trended over the last eight quarters',
        'quarterly board reporting metrics dashboard: support backlog aging as a health tile',
        'quarterly board reporting metrics dashboard: activation funnel by acquisition channel',
        'quarterly board reporting metrics dashboard: infra spend normalized per active org',
        'quarterly board reporting metrics dashboard: uptime SLO burn beside incident count',
      ];
      for (const content of decoyContents) {
        const decoy = await mcp.callTool('remember', {
          content,
          kind: 'decision',
          scope: 'personal',
        });
        expect(decoy.isError ?? false).toBe(false);
      }

      // A fresh decision in the caller's PERSONAL scope (the default landing
      // scope of `remember`), unrelated to the topic → recency-only path.
      const personal = await mcp.callTool('remember', {
        content: 'adopted a monorepo layout for the mobile client codebase',
        kind: 'decision',
        scope: 'personal',
      });
      expect(personal.isError ?? false).toBe(false);
      const { memory_id: personalId } = firstJson<{ memory_id: string }>(
        personal
      );
      await backdateMemory(personalId, 2);

      // A fresh decision widened into a SHAREABLE project scope that the
      // session does not pin. `share` rewrites the memory's scope to the
      // canonical per-owner `proj.<caller>.zm_foreign_e2e` (the legacy 2-label
      // form is canonicalized on the write path) and bootstraps membership.
      const foreign = await mcp.callTool('remember', {
        content: 'picked gRPC over REST for the media-transcode worker handoff',
        kind: 'decision',
        scope: 'personal',
      });
      expect(foreign.isError ?? false).toBe(false);
      const { memory_id: foreignId } = firstJson<{ memory_id: string }>(
        foreign
      );
      const shared = await mcp.callTool('share', {
        memory_id: foreignId,
        scope: 'proj.zm_foreign_e2e',
      });
      expect(shared.isError ?? false).toBe(false);
      await backdateMemory(foreignId, 2);

      // Topic matches the decoys, NOT the targets, and NO explicit scopes: with
      // no pinned project the read degrades to all visible scopes, so recency
      // is the only leg the two targets can take.
      const briefing = firstJson<BriefingPack>(
        await mcp.callTool('build_context', {
          topic: 'quarterly board reporting metrics dashboard',
          briefing: true,
        })
      );
      const ranked = [...briefing.memories, ...briefing.linked_memories].map(
        (memory) => memory.id
      );
      // Guard the premise: neither target may be a ranked hit, else the
      // assertion below would pass for the wrong reason.
      expect(ranked, 'personal target must not be a ranked hit').not.toContain(
        personalId
      );
      expect(ranked, 'foreign target must not be a ranked hit').not.toContain(
        foreignId
      );

      const recentIds = (briefing.recent ?? []).map((memory) => memory.id);
      // The personal decision is intentionally cross-cutting — it stays.
      expect(
        recentIds,
        'a personal-scope decision stays eligible for recency'
      ).toContain(personalId);
      // The foreign project decision must NOT lead the briefing: the relevance-
      // free recency leg admits shareable scopes only when they are briefed.
      expect(
        recentIds,
        'a foreign project scope must not surface through recent[]'
      ).not.toContain(foreignId);
    } finally {
      await mcp.close();
    }
  });

  test('a rules-promoted memory leaves briefings but stays recallable', async () => {
    const user = await provisionE2EUser('briefing-recency@zm.e2e');
    const mcp = await McpTestClient.connect(await passwordGrantToken(user));
    try {
      const remembered = await mcp.callTool('remember', {
        content:
          'always run the schema linter before pushing a migration to the ' +
          'shared stack',
        kind: 'convention',
        scope: 'personal',
      });
      expect(remembered.isError ?? false).toBe(false);
      const { memory_id } = firstJson<{ memory_id: string }>(remembered);

      // Fixture: mark the memory promoted into the rules layer (the
      // incubator's own promote flow is covered by the rules e2e).
      const { error: promoteError } = await adminClient()
        .from('rule_candidates')
        .insert({
          memory_id,
          useful_sessions: 3,
          window_days: 30,
          status: 'promoted',
          resolution: 'promoted',
          promoted_at: new Date().toISOString(),
        });
      expect(promoteError).toBeNull();

      // Out of the briefing: neither ranked legs nor recent deliver it.
      const briefing = firstJson<BriefingPack>(
        await mcp.callTool('build_context', {
          topic: 'schema linter before pushing a migration',
          briefing: true,
        })
      );
      const delivered = [
        ...briefing.memories,
        ...briefing.linked_memories,
        ...(briefing.recent ?? []),
      ].map((memory) => memory.id);
      expect(delivered).not.toContain(memory_id);

      // …but a mid-session build_context still finds it (hard filter is
      // briefing-only)…
      const midSession = firstJson<BriefingPack>(
        await mcp.callTool('build_context', {
          topic: 'schema linter before pushing a migration',
        })
      );
      expect(
        [...midSession.memories, ...midSession.linked_memories].map(
          (memory) => memory.id
        )
      ).toContain(memory_id);

      // …and so does a direct recall.
      const recalled = await mcp.callTool('recall', {
        query: 'schema linter before pushing migrations',
        k: 10,
      });
      expect(contentText(recalled)).toContain(memory_id);
    } finally {
      await mcp.close();
    }
  });
});
