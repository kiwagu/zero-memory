/**
 * Write-time entity anchoring, end-to-end over MCP: a write that names no
 * subject is anchored to entities its scope already knows and reports the key
 * it got; a decision whose subject the graph cannot name is handed back to its
 * author instead of being stored with an empty key; and a subject the caller
 * did state is used as given rather than being widened.
 *
 * Why these: anchoring exists so a memory is reachable from what it is ABOUT
 * and not only by phrasing it the same way, so the failures that would hurt
 * most are an anchor that never lands, an empty key that passes silently, and
 * a machine guess overriding what the author said.
 *
 * The last of those is covered from both sides, because resolution has to be
 * exactly as sharp as the names are: two subjects whose names differ only in
 * their digits stay two nodes, while one subject spelled with different
 * separators or casing stays one.
 */
import { expect, test } from '@playwright/test';

import { readSeedState } from '../helpers/runtime-state.js';
import { firstJson, McpTestClient } from '../helpers/mcp.js';
import { passwordGrantToken } from '../helpers/users.js';

interface RememberOut {
  memory_id: string;
  anchors?: string[];
  anchor_hint?: string;
}

/** A subject name unlikely to collide with anything else in the corpus. */
const SUBJECT = 'e2e anchor probe subject';

test.describe('Write-time entity anchoring over MCP', () => {
  test('a write that names no subject is anchored to what the scope already knows', async () => {
    const seed = await readSeedState();
    const mcp = await McpTestClient.connect(
      await passwordGrantToken(seed.userB)
    );
    try {
      // Teach the scope the subject once, by naming it explicitly.
      const first = await mcp.callTool('remember', {
        content: `the ${SUBJECT} was introduced to carry this test`,
        kind: 'decision',
        scope: 'personal',
        entities: [{ name: SUBJECT }],
      });
      expect(first.isError ?? false).toBe(false);
      const firstOut = firstJson<RememberOut>(first);
      // A stated subject is used as given — not widened by a machine guess.
      expect(firstOut.anchors).toEqual([SUBJECT]);

      // A LATER write names nothing, but speaks the same subject. The server
      // resolves it against the graph rather than storing an empty key.
      const second = await mcp.callTool('remember', {
        content:
          `the ${SUBJECT} keeps its meaning across sessions, which is the ` +
          'whole point of anchoring a decision to it',
        kind: 'decision',
        scope: 'personal',
      });
      expect(second.isError ?? false).toBe(false);
      const secondOut = firstJson<RememberOut>(second);
      expect(secondOut.anchors).toContain(SUBJECT);
      // The ask arrives anyway: what the server resolved is a floor, not a
      // verdict on the subject, so it must not silence the request.
      expect(secondOut.anchor_hint).toBeTruthy();
    } finally {
      await mcp.close();
    }
  });

  test('a decision the graph cannot key at all is still handed back to its author', async () => {
    const seed = await readSeedState();
    const mcp = await McpTestClient.connect(
      await passwordGrantToken(seed.userB)
    );
    try {
      // Deliberately built from words no entity in this scope carries, so
      // the deterministic pass can find nothing and the residue is visible.
      const written = await mcp.callTool('remember', {
        content:
          'zqxwv thplkj settled that grbnm should replace vfhtd whenever ' +
          'xkcdq is present',
        kind: 'decision',
        scope: 'personal',
      });
      expect(written.isError ?? false).toBe(false);
      const out = firstJson<RememberOut>(written);
      expect(out.anchors).toBeUndefined();
      expect(out.anchor_hint).toBeTruthy();
      expect(out.anchor_hint).toContain('entities:');
    } finally {
      await mcp.close();
    }
  });

  test('a serial-numbered subject is created, not folded into its neighbour', async () => {
    // The regression this guards: resolution used to attach a stated name to
    // whatever the scope held that merely LOOKED like it, so two records whose
    // names differ only in digits collapsed onto one node — and every decision
    // about the newer one became reachable only from the older, unrelated one.
    const seed = await readSeedState();
    const mcp = await McpTestClient.connect(
      await passwordGrantToken(seed.userB)
    );
    const first = 'E2E-PROBE-4120';
    const sibling = 'E2E-PROBE-4210';
    try {
      const older = await mcp.callTool('remember', {
        content: `${first} records the earlier of two unrelated decisions`,
        kind: 'decision',
        scope: 'personal',
        entities: [{ name: first }],
      });
      expect(firstJson<RememberOut>(older).anchors).toEqual([first]);

      const newer = await mcp.callTool('remember', {
        content: `${sibling} records the later one, which shares no subject`,
        kind: 'decision',
        scope: 'personal',
        entities: [{ name: sibling }],
      });
      // Named as given: the digits are the whole difference between the two
      // subjects, and resolution must be able to see them.
      expect(firstJson<RememberOut>(newer).anchors).toEqual([sibling]);
    } finally {
      await mcp.close();
    }
  });

  test('the same subject spelled differently attaches to the node it already has', async () => {
    const seed = await readSeedState();
    const mcp = await McpTestClient.connect(
      await passwordGrantToken(seed.userB)
    );
    const canonical = 'e2e_probe_spelling';
    try {
      const first = await mcp.callTool('remember', {
        content: `${canonical} is written one way here`,
        kind: 'decision',
        scope: 'personal',
        entities: [{ name: canonical }],
      });
      expect(firstJson<RememberOut>(first).anchors).toEqual([canonical]);

      // Same subject, different separators and casing: one node, not three.
      for (const spelling of ['e2e-probe-spelling', 'E2E Probe Spelling']) {
        const again = await mcp.callTool('remember', {
          content: `${spelling} is written another way, meaning the same thing`,
          kind: 'decision',
          scope: 'personal',
          entities: [{ name: spelling }],
        });
        expect(
          firstJson<RememberOut>(again).anchors,
          `spelling ${spelling}`
        ).toEqual([canonical]);
      }
    } finally {
      await mcp.close();
    }
  });

  test('a kind whose missing subject is not worth an interruption is left alone', async () => {
    const seed = await readSeedState();
    const mcp = await McpTestClient.connect(
      await passwordGrantToken(seed.userB)
    );
    try {
      const written = await mcp.callTool('remember', {
        content:
          'zqxwv thplkj measured grbnm at vfhtd on the xkcdq run, which is ' +
          'merely an observation',
        kind: 'fact',
        scope: 'personal',
      });
      expect(written.isError ?? false).toBe(false);
      const out = firstJson<RememberOut>(written);
      // No ask: it is reserved for the kind other sessions come looking for
      // by name, so it stays rare enough to be read.
      expect(out.anchor_hint).toBeUndefined();
    } finally {
      await mcp.close();
    }
  });
});
