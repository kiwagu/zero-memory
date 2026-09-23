/**
 * The branch store at the level a direct PostgREST call meets it: a card
 * records the git branches its work ran on, a branch is visible exactly where
 * its card is, and a malformed branch never reaches the table.
 */
import { expect, test } from '@playwright/test';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import { e2eEnv } from '../helpers/env.js';
import { firstJson, McpTestClient } from '../helpers/mcp.js';
import { readSeedState } from '../helpers/runtime-state.js';
import { passwordGrantToken } from '../helpers/users.js';

const REPO = 'acme/memory-service';

interface CardJson {
  id: string;
  number: number;
  scope: string;
  state: string;
}

interface BranchJson {
  repo: string;
  branch: string;
  state: string;
  squash_sha: string | null;
  target: string | null;
  landed_at: string | null;
}

interface EventJson {
  type: string;
  from_state: string | null;
  to_state: string | null;
  reason: string | null;
  ref_kind: string | null;
  ref_target: string | null;
  branch_note: string | null;
  squash_sha: string | null;
  target_branch: string | null;
}

interface CardGetJson {
  error?: string;
  card: CardJson;
  branches: BranchJson[];
  events: EventJson[];
}

const asUser = (token: string): SupabaseClient =>
  createClient(e2eEnv.supabaseUrl, e2eEnv.supabaseAnonKey, {
    auth: { persistSession: false },
    global: { headers: { Authorization: `Bearer ${token}` } },
  });

/** A project scope the caller may write, made the way an agent makes one. */
const projectScope = async (token: string, tag: string): Promise<string> => {
  const agent = await McpTestClient.connect(token);
  try {
    const made = await agent.callTool('remember', {
      content: `e2e branch store marker ${tag}: the ingest worker drops chunks under load`,
      kind: 'fact',
      project_hint: `/tmp/zm-e2e-${tag}`,
    });
    expect(made.isError ?? false).toBe(false);
    return firstJson<{ scope: string }>(made).scope;
  } finally {
    await agent.close();
  }
};

const rpc = async <T>(
  client: SupabaseClient,
  fn: string,
  args: Record<string, unknown>
): Promise<T> => {
  const { data, error } = await client.rpc(fn, args);
  if (error) {
    throw new Error(`${fn}: ${error.message}`);
  }
  return data as T;
};

test.describe('Card branches in the store', () => {
  test('a branch attaches once, reads back with its card, and detaches', async () => {
    const seed = await readSeedState();
    const token = await passwordGrantToken(seed.userA);
    const scope = await projectScope(token, `branch-store-${Date.now()}`);
    const db = asUser(token);
    const { card } = await rpc<{ card: CardJson }>(db, 'card_create', {
      p_scope: scope,
      p_title: 'Page the memory feed',
    });

    const target = `${REPO}:feature/feed-pages`;
    const first = await rpc<{ changed: boolean }>(db, 'card_attach', {
      p_card_id: card.id,
      p_kind: 'branch',
      p_target: target,
    });
    expect(first.changed).toBe(true);
    const again = await rpc<{ changed: boolean }>(db, 'card_attach', {
      p_card_id: card.id,
      p_kind: 'branch',
      p_target: target,
    });
    expect(again.changed).toBe(false);

    const read = await rpc<CardGetJson>(db, 'card_get', {
      p_card_id: card.id,
    });
    expect(read.branches).toEqual([
      expect.objectContaining({
        repo: REPO,
        branch: 'feature/feed-pages',
        state: 'open',
        squash_sha: null,
        target: null,
        landed_at: null,
      }),
    ]);
    expect(read.events.filter((event) => event.type === 'attached')).toEqual([
      expect.objectContaining({ ref_kind: 'branch', ref_target: target }),
    ]);
    // Every event carries the new columns, empty where they do not apply.
    for (const event of read.events) {
      expect(event).toMatchObject({
        branch_note: null,
        squash_sha: null,
        target_branch: null,
      });
    }

    for (const malformed of [
      'no-colon-here',
      `${REPO}:feature/has space`,
      `${REPO}:feature/a..b`,
      'owner name:feature/x',
      `${REPO}:`,
    ]) {
      const refused = await rpc<{ error?: string }>(db, 'card_attach', {
        p_card_id: card.id,
        p_kind: 'branch',
        p_target: malformed,
      });
      expect(refused.error, malformed).toBe('invalid');
    }

    const detached = await rpc<{ error?: string }>(db, 'card_detach', {
      p_card_id: card.id,
      p_kind: 'branch',
      p_target: target,
    });
    expect(detached.error).toBeUndefined();
    const after = await rpc<CardGetJson>(db, 'card_get', {
      p_card_id: card.id,
    });
    expect(after.branches).toEqual([]);
    expect(after.events.at(-1)).toMatchObject({
      type: 'detached',
      ref_kind: 'branch',
      ref_target: target,
    });
    const gone = await rpc<{ error?: string }>(db, 'card_detach', {
      p_card_id: card.id,
      p_kind: 'branch',
      p_target: target,
    });
    expect(gone.error).toBe('not_attached');
  });

  test('a stranger sees no branch of a card they cannot see, and cannot add one', async () => {
    const seed = await readSeedState();
    const ownerToken = await passwordGrantToken(seed.userA);
    const scope = await projectScope(ownerToken, `branch-rls-${Date.now()}`);
    const owner = asUser(ownerToken);
    const { card } = await rpc<{ card: CardJson }>(owner, 'card_create', {
      p_scope: scope,
      p_title: 'Rotate the edge certificates',
    });
    await rpc(owner, 'card_attach', {
      p_card_id: card.id,
      p_kind: 'branch',
      p_target: `${REPO}:feature/certs`,
    });

    const stranger = asUser(await passwordGrantToken(seed.userB));
    const peek = await stranger
      .from('card_branches')
      .select('*')
      .eq('card_id', card.id);
    expect(peek.error).toBeNull();
    expect(peek.data).toEqual([]);

    const read = await rpc<{ error?: string }>(stranger, 'card_get', {
      p_card_id: card.id,
    });
    expect(read.error).toBe('not_found');
    const added = await rpc<{ error?: string }>(stranger, 'card_attach', {
      p_card_id: card.id,
      p_kind: 'branch',
      p_target: `${REPO}:feature/forged`,
    });
    expect(added.error).toBe('not_found');

    const forged = await stranger.from('card_branches').insert({
      card_id: card.id,
      scope,
      repo: REPO,
      branch: 'feature/forged',
    });
    expect(forged.error).not.toBeNull();
  });
});
