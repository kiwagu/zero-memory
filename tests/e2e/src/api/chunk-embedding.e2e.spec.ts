/**
 * A fact stated past the embedding model's input window is still recalled.
 *
 * The model truncates its input to a fixed window silently, so a long passage
 * used to be represented by its opening alone. The fixture here is built so
 * that the ONLY way to find it by its closing subject is an overflow window: its
 * opening is long enough to fill the window on its own and says nothing about
 * that subject, and the recall query is a deliberate paraphrase sharing no
 * distinctive stem with the closing, so the text leg cannot reach it either.
 *
 * Before the overflow windows existed this recall returned nothing.
 */
import { createClient } from '@supabase/supabase-js';
import { expect, test } from '@playwright/test';

import { e2eEnv } from '../helpers/env.js';
import { contentText, firstJson, McpTestClient } from '../helpers/mcp.js';
import { readSeedState } from '../helpers/runtime-state.js';
import { passwordGrantToken } from '../helpers/users.js';

/**
 * Roughly 3200 characters — comfortably past the window, so nothing after it
 * reaches the head vector. Its subject is deliberately unrelated to the
 * closing one.
 */
const LONG_OPENING = (
  'The quarterly operations handbook records the standing arrangements the ' +
  'team keeps returning to, restated at length here so that the opening of ' +
  'this record fills the model input window entirely on its own. ' +
  'It covers meeting cadence, who owns the release calendar, how holiday ' +
  'cover is arranged, and where the signed supplier contracts are filed. '
).repeat(9);

/** The subject that exists ONLY past the window. */
const CLOSING_SUBJECT =
  'The greenhouse irrigation valves open at dawn and shut again once soil ' +
  'moisture crosses the configured threshold, so the seedling trays are ' +
  'never left standing in water. The gardener checks the drip lines every ' +
  'week for blockages and replaces any emitter that has silted up over the ' +
  'growing season.';

/** Shares no distinctive stem with the closing — only meaning connects them. */
const PARAPHRASED_QUERY = 'automatic watering of plants early in the day';

const adminClient = () =>
  createClient(e2eEnv.supabaseUrl, e2eEnv.supabaseServiceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

const remember = async (
  mcp: McpTestClient,
  content: string
): Promise<string> => {
  const result = await mcp.callTool('remember', {
    content,
    kind: 'fact',
    scope: 'personal',
  });
  expect(result.isError ?? false).toBe(false);
  return firstJson<{ memory_id: string }>(result).memory_id;
};

const overflowWindows = async (memoryId: string): Promise<number> => {
  const { count, error } = await adminClient()
    .from('memory_chunks')
    .select('ord', { count: 'exact', head: true })
    .eq('memory_id', memoryId);
  if (error) {
    throw new Error(`read windows of ${memoryId} failed: ${error.message}`);
  }
  return count ?? 0;
};

test.describe('chunk embedding', () => {
  test('a subject stated only after the model window is recalled', async () => {
    const seed = await readSeedState();
    // User B, like the other ranking specs: these fixtures would otherwise
    // leak into user A's surfaced-count and top-facts assertions.
    const mcp = await McpTestClient.connect(
      await passwordGrantToken(seed.userB)
    );

    const longId = await remember(mcp, `${LONG_OPENING}${CLOSING_SUBJECT}`);
    const shortId = await remember(
      mcp,
      'The office kettle is descaled on the first Monday of every month.'
    );

    // Wiring: length alone decides how many windows a record carries, and a
    // record that fits the model's window whole carries none.
    expect(await overflowWindows(longId)).toBeGreaterThan(0);
    expect(await overflowWindows(shortId)).toBe(0);

    const recalled = await mcp.callTool('recall', {
      query: PARAPHRASED_QUERY,
      k: 10,
    });
    expect(recalled.isError ?? false).toBe(false);
    expect(contentText(recalled)).toContain(longId);

    // FIRST, not merely present: this corpus is small enough that the top ten
    // holds nearly all of it, so "is in the hits" is an assertion that cannot
    // fail. Ranked by the primary vector alone the record sits third, behind
    // two short unrelated memories; the overflow window is what puts it
    // first, by a score margin of roughly 1.8x over the runner-up.
    const hits = firstJson<{ memories: { id: string }[] }>(recalled).memories;
    expect(hits[0]?.id).toBe(longId);
  });
});
