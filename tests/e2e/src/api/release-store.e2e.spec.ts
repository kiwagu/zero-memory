/**
 * The release store at the level a direct PostgREST call meets it: a project
 * names where its production state lives, only its admin may say so, and a
 * url carrying credentials never reaches the table.
 */
import { spawnSync } from 'node:child_process';

import { expect, test } from '@playwright/test';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import { e2eEnv } from '../helpers/env.js';
import { firstJson, McpTestClient } from '../helpers/mcp.js';
import { readSeedState } from '../helpers/runtime-state.js';
import { passwordGrantToken } from '../helpers/users.js';

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
      content: `e2e release store marker ${tag}: the ingest worker drops chunks under load`,
      kind: 'fact',
      project_hint: `/tmp/zm-e2e-${tag}`,
    });
    expect(made.isError ?? false).toBe(false);
    return firstJson<{ scope: string }>(made).scope;
  } finally {
    await agent.close();
  }
};

/** One statement against the e2e database, as the migration tests run it. */
const psql = (query: string): string => {
  const result = spawnSync(
    'docker',
    [
      'run',
      '--rm',
      '--network',
      'host',
      '-i',
      'supabase/postgres:17.6.1.136',
      'psql',
      'postgresql://postgres:postgres@127.0.0.1:55332/postgres',
      '-v',
      'ON_ERROR_STOP=1',
      '-tA',
      '-c',
      query,
    ],
    { encoding: 'utf8' }
  );
  if (result.status !== 0) {
    throw new Error(`psql failed: ${result.stderr}`);
  }
  return (result.stdout ?? '').trim();
};

test.describe('Release settings in the store', () => {
  test('only a scope admin writes the setting; members read it; a bad url never lands', async () => {
    const seed = await readSeedState();
    const token = await passwordGrantToken(seed.userA);
    const scope = await projectScope(token, `release-settings-${Date.now()}`);
    const db = asUser(token);

    const empty = await db
      .from('scope_release_settings')
      .select('*')
      .eq('scope', scope);
    expect(empty.error).toBeNull();
    expect(empty.data).toEqual([]);

    // Someone outside the project cannot name its production.
    const stranger = asUser(await passwordGrantToken(seed.userB));
    const foreign = await stranger
      .from('scope_release_settings')
      .insert({ scope, version_url: 'https://evil.example.com/x' });
    expect(foreign.error).not.toBeNull();

    // The admin can, but never with credentials in the url.
    const leaky = await db
      .from('scope_release_settings')
      .insert({ scope, version_url: 'https://user:pw@example.com/healthz' });
    expect(leaky.error?.message).toMatch(/check constraint/u);

    for (const bad of [
      "select private.is_release_url('https://user:pw@example.com/healthz')",
      "select private.is_release_url('http://example.com/healthz')",
      "select private.is_release_url('ftp://example.com')",
    ]) {
      expect(psql(bad)).toBe('f');
    }
    for (const good of [
      "select private.is_release_url('https://api.example.com/healthz')",
      "select private.is_release_url('http://localhost:8788/healthz')",
      "select private.is_release_url('http://127.0.0.1:8788/healthz')",
    ]) {
      expect(psql(good)).toBe('t');
    }
  });
});
