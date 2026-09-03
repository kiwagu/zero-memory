/**
 * The open-loops section spends its budget where the topic points.
 *
 * Every active loop still surfaces on every briefing — that is lifecycle, not
 * relevance — but a uniform 400-character cap delivered only each loop's
 * opening, while a handover record states what to do on return at its END.
 * So relevance now decides DEPTH: the loop NEAREST the topic arrives whole, the
 * rest keep their headline.
 *
 * The assertion that makes this sharp is the SWAP: the same two loops, two
 * topics, and the full one follows the topic. Under the previous behaviour
 * both were always truncated, so this spec could not pass by accident.
 *
 * A freshly provisioned owner keeps the loop set to exactly these two, which
 * the ten-oldest window would otherwise share with the rest of the suite.
 */
import { expect, test } from '@playwright/test';

import { firstJson, McpTestClient } from '../helpers/mcp.js';
import { passwordGrantToken, provisionE2EUser } from '../helpers/users.js';

interface BriefingPack {
  open_loops: Array<{
    id: string;
    content: string;
    truncated: boolean;
  }>;
}

/** Long enough that a 400-character cap is unmistakable in the assertions. */
const BACKUP_LOOP =
  'TASK — the nightly backup restore drill is only half automated. The dump ' +
  'lands on the operator box and is verified by checksum, but restoring it ' +
  'into the spare stack is still typed by hand every time, and the watermark ' +
  'check afterwards is remembered rather than enforced. ' +
  'Everything above is context; what an incoming session actually has to do ' +
  'is written here at the end, which is exactly the part a head-truncation ' +
  'drops: restore into the spare stack first, compare the schema watermark ' +
  'against the ledger before trusting a single row, and only then point any ' +
  'reader at it. The drill is not finished until that comparison is a command ' +
  'rather than a habit, and the operator box keeps its own copy of the dump ' +
  'until the comparison passes.';

const SIDEBAR_LOOP =
  'TASK — the dashboard sidebar collapses badly on narrow viewports. Below ' +
  'roughly nine hundred pixels the navigation column overlaps the content ' +
  'area instead of folding into the drawer, and the scroll container keeps ' +
  'its desktop height so the footer links sit off screen. ' +
  'The remaining work, stated at the end where a truncated read would lose ' +
  'it: fold the column into the drawer at the same breakpoint the header ' +
  'already uses rather than inventing a second one, give the scroll container ' +
  'a viewport-relative height, and check the result at the two narrow sizes ' +
  'the screenshot suite already captures before touching any other layout.';

const BACKUP_TOPIC = 'restoring a database dump and checking its watermark';
const SIDEBAR_TOPIC = 'navigation column layout on small screens';

const rememberLoop = async (
  mcp: McpTestClient,
  content: string
): Promise<string> => {
  const result = await mcp.callTool('remember', {
    content,
    kind: 'task',
    scope: 'personal',
  });
  expect(result.isError ?? false).toBe(false);
  return firstJson<{ memory_id: string }>(result).memory_id;
};

const loopsFor = async (
  mcp: McpTestClient,
  topic: string
): Promise<BriefingPack['open_loops']> => {
  const briefing = await mcp.callTool('build_context', { topic });
  expect(briefing.isError ?? false).toBe(false);
  return firstJson<BriefingPack>(briefing).open_loops;
};

test.describe('open-loop focus', () => {
  test('the loop nearest the topic arrives whole, the others as headlines', async () => {
    const user = await provisionE2EUser(`zm-loop-focus-${Date.now()}@zm.e2e`);
    const mcp = await McpTestClient.connect(await passwordGrantToken(user));
    try {
      const backupId = await rememberLoop(mcp, BACKUP_LOOP);
      const sidebarId = await rememberLoop(mcp, SIDEBAR_LOOP);

      const onBackupTopic = await loopsFor(mcp, BACKUP_TOPIC);
      const backupFocused = onBackupTopic.find((l) => l.id === backupId);
      const sidebarStub = onBackupTopic.find((l) => l.id === sidebarId);

      // Both surface — depth changed, selection did not.
      expect(backupFocused, 'every active loop still surfaces').toBeTruthy();
      expect(sidebarStub, 'every active loop still surfaces').toBeTruthy();

      expect(backupFocused!.truncated).toBe(false);
      expect(backupFocused!.content).toBe(BACKUP_LOOP);
      // The instruction lives at the end — the whole reason for the change.
      expect(backupFocused!.content).toContain('rather than a habit');

      expect(sidebarStub!.truncated).toBe(true);
      expect(sidebarStub!.content.length).toBeLessThan(SIDEBAR_LOOP.length);

      // THE SWAP: same two loops, other topic, the depth follows.
      const onSidebarTopic = await loopsFor(mcp, SIDEBAR_TOPIC);
      const sidebarFocused = onSidebarTopic.find((l) => l.id === sidebarId);
      const backupStub = onSidebarTopic.find((l) => l.id === backupId);

      expect(sidebarFocused!.truncated).toBe(false);
      expect(sidebarFocused!.content).toBe(SIDEBAR_LOOP);
      expect(backupStub!.truncated).toBe(true);
    } finally {
      await mcp.close();
    }
  });
});
