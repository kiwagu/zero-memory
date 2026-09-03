/**
 * A write that outgrew the model's input window comes back with an
 * instruction, at the one moment the writer can act on it.
 *
 * Retrieval used to punish length silently — everything past the window never
 * entered the vector — and that penalty is gone, so nothing about length is
 * visible at write time any more. The reasons to stay short survive: a
 * briefing inlines only part of a memory, and a record cannot be superseded in
 * halves. This is what puts those reasons in front of the writer instead of
 * leaving them in a convention nothing enforces.
 */
import { expect, test } from '@playwright/test';

import { firstJson, McpTestClient } from '../helpers/mcp.js';
import { passwordGrantToken, provisionE2EUser } from '../helpers/users.js';

interface RememberResult {
  memory_id: string;
  length_directive?: string;
}

/** Comfortably past one window, so the write cannot help but overflow. */
const OVERSIZE = (
  'The quarterly operations review records the arrangements the team keeps ' +
  'returning to: who owns the release calendar, how holiday cover is agreed, ' +
  'where the signed supplier contracts are filed, and which consumables are ' +
  'reordered on sight rather than on request. '
).repeat(9);

const WITHIN_THE_WINDOW =
  'The office kettle is descaled on the first Monday of every month, and the ' +
  'spare filter lives in the cupboard above the sink.';

test.describe('oversize write directive', () => {
  test('a long write is instructed; a short one is left alone', async () => {
    const user = await provisionE2EUser(`zm-oversize-${Date.now()}@zm.e2e`);
    const mcp = await McpTestClient.connect(await passwordGrantToken(user));
    try {
      const remember = async (content: string): Promise<RememberResult> => {
        const result = await mcp.callTool('remember', {
          content,
          kind: 'fact',
          scope: 'personal',
        });
        expect(result.isError ?? false).toBe(false);
        return firstJson<RememberResult>(result);
      };

      const long = await remember(OVERSIZE);
      expect(
        long.length_directive,
        'a write past the window must come back with the instruction'
      ).toBeTruthy();
      // It reports this write's own cost and instructs the next one — the two
      // halves that make it a directive rather than a nag.
      // The STORED length, which is the trimmed one — the directive reports
      // what landed, not what was sent.
      expect(long.length_directive).toContain(String(OVERSIZE.trim().length));
      expect(long.length_directive).toContain('Keep the next one');

      const short = await remember(WITHIN_THE_WINDOW);
      expect(
        short.length_directive,
        'an ordinary write must not be lectured: the instruction fires on a ' +
          'real miss, which is what keeps it worth reading'
      ).toBeUndefined();
    } finally {
      await mcp.close();
    }
  });
});
