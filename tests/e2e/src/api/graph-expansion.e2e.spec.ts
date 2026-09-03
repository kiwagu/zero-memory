/**
 * Graph expansion end-to-end, both halves of it.
 *
 * `recall` carries typed-link neighbours of its hits as STUBS: a flat hit list
 * drops exactly the relations that change what a fact means (what superseded
 * it, what it contradicts), and a caller cannot ask for what it does not know
 * exists. The stub says which memory, how it relates and to which hit; the
 * body stays one call away.
 *
 * `build_context` gives those relations a RESERVED slice of the linked leg, so
 * a relation displaces an entity co-mention instead of enlarging the pack.
 */
import { expect, test } from '@playwright/test';

import { firstJson, McpTestClient } from '../helpers/mcp.js';
import { passwordGrantToken, provisionE2EUser } from '../helpers/users.js';

interface RelatedStub {
  id: string;
  of: string;
  relation: string;
  kind: string;
  preview: string;
}

interface RecallResult {
  memories: Array<{ id: string }>;
  related: RelatedStub[];
}

test.describe('Graph expansion over MCP', () => {
  test('recall names a linked memory the query itself would not surface', async () => {
    const user = await provisionE2EUser('graph-expansion-recall@zm.e2e');
    const mcp = await McpTestClient.connect(await passwordGrantToken(user));
    try {
      // The neighbour is deliberately written in UNRELATED words: if it shows
      // up, it came through the link and not through similarity.
      const neighbour = await mcp.callTool('remember', {
        content:
          'the harbour crane inspection is scheduled every second Tuesday ' +
          'and the logbook lives with the dock supervisor',
        kind: 'convention',
        scope: 'personal',
      });
      const neighbourId = firstJson<{ memory_id: string }>(neighbour).memory_id;

      const hit = await mcp.callTool('remember', {
        content:
          'chose the quorum handover protocol for the ledger writer because ' +
          'a single writer stalled every failover drill',
        kind: 'decision',
        scope: 'personal',
        links: [{ type: 'relates_to', dst: neighbourId }],
      });
      const hitId = firstJson<{ memory_id: string }>(hit).memory_id;

      const recalled = firstJson<RecallResult>(
        // k: 1 keeps the neighbour OUT of the hits — otherwise a small
        // corpus returns it as a hit of its own and the stub is correctly
        // suppressed as a duplicate, testing nothing.
        await mcp.callTool('recall', {
          query: 'quorum handover protocol for the ledger writer',
          k: 1,
        })
      );

      expect(recalled.memories.map((row) => row.id)).toContain(hitId);
      const stub = recalled.related.find((row) => row.id === neighbourId);
      expect(stub, 'the linked memory should be named').toBeDefined();
      expect(stub?.of).toBe(hitId);
      expect(stub?.relation).toBe('relates_to');
      expect(stub?.kind).toBe('convention');
      // A stub, not a body: the preview is an opening, not the whole memory.
      expect(stub?.preview.length).toBeLessThanOrEqual(120);
      expect(stub?.preview.startsWith('the harbour crane inspection')).toBe(
        true
      );
    } finally {
      await mcp.close();
    }
  });

  test('a retired neighbour is never offered as if it still held', async () => {
    const user = await provisionE2EUser('graph-expansion-retired@zm.e2e');
    const mcp = await McpTestClient.connect(await passwordGrantToken(user));
    try {
      const old = await mcp.callTool('remember', {
        content: 'the export feed pages by offset, twenty rows at a time',
        kind: 'decision',
        scope: 'personal',
      });
      const oldId = firstJson<{ memory_id: string }>(old).memory_id;

      // Superseding retires the predecessor — the relation exists, but the
      // memory behind it must not come back through the graph.
      const replacement = await mcp.callTool('remember', {
        content:
          'the export feed pages by cursor now: offset scans degraded past ' +
          'one million rows',
        kind: 'decision',
        scope: 'personal',
        links: [{ type: 'supersedes', dst: oldId }],
      });
      const newId = firstJson<{ memory_id: string }>(replacement).memory_id;

      const recalled = firstJson<RecallResult>(
        await mcp.callTool('recall', { query: 'export feed pagination' })
      );

      expect(recalled.memories.map((row) => row.id)).toContain(newId);
      expect(recalled.related.map((row) => row.id)).not.toContain(oldId);
    } finally {
      await mcp.close();
    }
  });

  test('a relation never carries a memory across the owner boundary', async () => {
    // The stub path reads memory_links and embeds both endpoints. RLS is what
    // keeps that inside one account, and this is the assertion that says so:
    // a link is only visible when BOTH its endpoints are, so a foreign
    // memory must not arrive as somebody's "related" — the one way this
    // feature could leak data that recall itself never would.
    const owner = await provisionE2EUser('graph-expansion-owner@zm.e2e');
    const stranger = await provisionE2EUser('graph-expansion-stranger@zm.e2e');

    const seedOwnerSide = async (): Promise<{
      secretId: string;
      anchorId: string;
    }> => {
      const ownerMcp = await McpTestClient.connect(
        await passwordGrantToken(owner)
      );
      try {
        const secret = await ownerMcp.callTool('remember', {
          content:
            'the pilot boarding ladder is stowed behind the chart table on ' +
            'the north quay tender',
          kind: 'convention',
          scope: 'personal',
        });
        const secretId = firstJson<{ memory_id: string }>(secret).memory_id;
        const anchor = await ownerMcp.callTool('remember', {
          content:
            'tender crews change over at slack water so the handover never ' +
            'happens under load',
          kind: 'decision',
          scope: 'personal',
          links: [{ type: 'relates_to', dst: secretId }],
        });
        return {
          secretId,
          anchorId: firstJson<{ memory_id: string }>(anchor).memory_id,
        };
      } finally {
        await ownerMcp.close();
      }
    };
    const { secretId, anchorId } = await seedOwnerSide();

    const strangerMcp = await McpTestClient.connect(
      await passwordGrantToken(stranger)
    );
    try {
      // The stranger writes a memory whose words match the owner's anchor, so
      // the query itself is a plausible route to the neighbourhood.
      await strangerMcp.callTool('remember', {
        content: 'tender crews change over at slack water on my own quay too',
        kind: 'decision',
        scope: 'personal',
      });
      const recalled = firstJson<RecallResult>(
        await strangerMcp.callTool('recall', {
          query: 'tender crews change over at slack water',
        })
      );
      const reachable = [
        ...recalled.memories.map((row) => row.id),
        ...recalled.related.map((row) => row.id),
        ...recalled.related.map((row) => row.of),
      ];
      expect(reachable).not.toContain(secretId);
      expect(reachable).not.toContain(anchorId);
    } finally {
      await strangerMcp.close();
    }
  });

  test('a briefing leg does not grow when relations join it', async () => {
    const user = await provisionE2EUser('graph-expansion-pack@zm.e2e');
    const mcp = await McpTestClient.connect(await passwordGrantToken(user));
    try {
      const topic = 'freight settlement reconciliation';
      let previous: string | null = null;
      for (let index = 0; index < 6; index += 1) {
        const stored = await mcp.callTool('remember', {
          content:
            `${topic}: stage ${index} settles the ledger against the ` +
            `carrier statement and records variance ${index} for audit`,
          kind: 'decision',
          scope: 'personal',
          ...(previous
            ? { links: [{ type: 'relates_to', dst: previous }] }
            : {}),
        });
        previous = firstJson<{ memory_id: string }>(stored).memory_id;
      }

      const pack = firstJson<{
        memories: Array<{ id: string }>;
        linked_memories: Array<{ id: string }>;
      }>(await mcp.callTool('build_context', { topic, briefing: true }));

      // The reservation lives INSIDE the leg's cap: with max_memories at its
      // default the leg can never exceed it, however dense the graph is.
      expect(pack.linked_memories.length).toBeLessThanOrEqual(12);
      const ids = new Set(pack.linked_memories.map((row) => row.id));
      expect(ids.size).toBe(pack.linked_memories.length);
    } finally {
      await mcp.close();
    }
  });
});
