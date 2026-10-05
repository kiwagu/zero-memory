/**
 * The secret guard holds on every write that stores text a caller typed, not
 * only on memories: a card's title, body and reasons, a note on a card, the
 * names a `link` turns into entities, and the text `promote_rule` makes into
 * a standing rule. Each refusal is `validation_failed` with the stable
 * prefix, never echoes the secret, and leaves nothing behind.
 */
import { expect, test } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';

import { e2eEnv } from '../helpers/env.js';
import {
  contentText,
  firstJson,
  McpTestClient,
  type McpToolResult,
} from '../helpers/mcp.js';
import { readSeedState } from '../helpers/runtime-state.js';
import { passwordGrantToken } from '../helpers/users.js';

const PROJECT_HINT = '/tmp/zm-e2e-secret-guard';

// Built at run time so the repository holds no token-shaped literal.
const SECRET = ['ghp', 'A'.repeat(36)].join('_');

const admin = () =>
  createClient(e2eEnv.supabaseUrl, e2eEnv.supabaseServiceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

/** The refusal every guarded path answers with, and nothing of the secret. */
const expectRefused = (result: McpToolResult): void => {
  expect(result.isError, 'expected the write to be refused').toBe(true);
  const error = firstJson<{ error: { code: string; message: string } }>(
    result
  ).error;
  expect(error.code).toBe('validation_failed');
  expect(error.message).toMatch(/^secret_content_rejected: /);
  expect(contentText(result)).not.toContain(SECRET);
};

test.describe('the secret guard covers every typed text a write stores', () => {
  let mcp: McpTestClient;

  test.beforeAll(async () => {
    const seed = await readSeedState();
    mcp = await McpTestClient.connect(await passwordGrantToken(seed.userA));
  });

  test.afterAll(async () => {
    await mcp.close();
  });

  test('@smoke a card with a secret in its body is not opened', async () => {
    const title = `e2e secret guard card ${Date.now()}`;
    expectRefused(
      await mcp.callTool('card', {
        action: 'create',
        project_hint: PROJECT_HINT,
        title,
        body: `Rotate the runner token ${SECRET} before Friday.`,
        type: 'task',
        no_links: 'e2e fixture',
      })
    );
    const { data } = await admin()
      .from('cards')
      .select('id')
      .eq('title', title);
    expect(data).toEqual([]);
  });

  test('@smoke a note with a secret is not added to a card', async () => {
    const opened = await mcp.callTool('card', {
      action: 'create',
      project_hint: PROJECT_HINT,
      title: `e2e secret guard note target ${Date.now()}`,
      type: 'task',
      no_links: 'e2e fixture',
    });
    expect(opened.isError ?? false).toBe(false);
    const cardId = firstJson<{ card: { id: string } }>(opened).card.id;

    expectRefused(
      await mcp.callTool('card_log', {
        action: 'note',
        card_id: cardId,
        text: `the runner now uses ${SECRET}`,
      })
    );
    const { data } = await admin()
      .from('card_events')
      .select('text')
      .eq('card_id', cardId);
    expect(JSON.stringify(data ?? [])).not.toContain(SECRET);
  });

  test('@smoke a reason with a secret does not move a card', async () => {
    const opened = await mcp.callTool('card', {
      action: 'create',
      project_hint: PROJECT_HINT,
      title: `e2e secret guard move target ${Date.now()}`,
      type: 'task',
      no_links: 'e2e fixture',
    });
    const cardId = firstJson<{ card: { id: string } }>(opened).card.id;

    expectRefused(
      await mcp.callTool('card', {
        action: 'move',
        card_id: cardId,
        to: 'parked',
        reason: `parked until ${SECRET} is rotated`,
      })
    );
    const { data } = await admin()
      .from('cards')
      .select('state')
      .eq('id', cardId)
      .single();
    expect(data?.state).toBe('idea');
  });

  test('@smoke an entity name with a secret is not created by link', async () => {
    expectRefused(
      await mcp.callTool('link', {
        src: `e2e runner ${SECRET}`,
        dst: 'e2e deploy pipeline',
        type: 'uses',
      })
    );
    const { data } = await admin()
      .from('entities')
      .select('id')
      .ilike('name', `%${SECRET}%`);
    expect(data).toEqual([]);
  });

  test('@smoke a rule text with a secret is not promoted', async () => {
    const written = await mcp.callTool('remember', {
      content: `e2e secret guard rule source ${Date.now()}: deploys go through the runner`,
      kind: 'convention',
      scope: 'personal',
    });
    expect(written.isError ?? false).toBe(false);
    const memoryId = firstJson<{ memory_id: string }>(written).memory_id;

    expectRefused(
      await mcp.callTool('promote_rule', {
        memory_id: memoryId,
        rule_text: `Always deploy with ${SECRET}.`,
      })
    );
    const { data } = await admin()
      .from('rule_candidates')
      .select('status, rule_text')
      .eq('memory_id', memoryId)
      .maybeSingle();
    expect(data?.status ?? null).not.toBe('promoted');
    expect(JSON.stringify(data ?? {})).not.toContain(SECRET);
  });
});
