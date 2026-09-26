/**
 * Fixtures for specs that talk to the board store directly: callers as a
 * given user, the service role, SQL as the database owner, and a project
 * scope made the way an agent makes one.
 */
import { spawnSync } from 'node:child_process';

import { expect } from '@playwright/test';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import { e2eEnv } from './env.js';
import { firstJson, McpTestClient } from './mcp.js';

export const asUser = (token: string): SupabaseClient =>
  createClient(e2eEnv.supabaseUrl, e2eEnv.supabaseAnonKey, {
    auth: { persistSession: false },
    global: { headers: { Authorization: `Bearer ${token}` } },
  });

export const admin = (): SupabaseClient =>
  createClient(e2eEnv.supabaseUrl, e2eEnv.supabaseServiceRoleKey, {
    auth: { persistSession: false },
  });

export const rpc = async <T>(
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

/** SQL as the database owner, for fixtures no role may write through the API. */
export const psql = (query: string): string => {
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
      '-Atc',
      query,
    ],
    { encoding: 'utf8' }
  );
  if (result.status !== 0) {
    throw new Error(`psql: ${result.stderr}`);
  }
  return result.stdout.trim();
};

/**
 * One statement as a signed-in user, with session settings of its own: the
 * way to read what a setting changes without touching the database default.
 * The whole string runs as one implicit transaction, so `set local` ends
 * with it. psql prints every statement's result, so the answer is the last
 * line.
 */
export const asOwnerSql = (
  authUserId: string,
  statement: string,
  settings: Record<string, string> = {}
): string => {
  const claims = JSON.stringify({ sub: authUserId, role: 'authenticated' });
  const sets = Object.entries(settings)
    .map(([key, value]) => `set local ${key} = '${value}';`)
    .join(' ');
  const output = psql(
    `${sets} select set_config('request.jwt.claims', '${claims}', true); ` +
      `set local role authenticated; ${statement}`
  );
  return output.split('\n').at(-1) ?? '';
};

/**
 * A conversation id of its own; `tag` is one letter of the id alphabet
 * (Crockford base32 has no i, l, o or u).
 */
export const thread = (tag: string): string =>
  `thr_e2emine${tag}${String(Date.now()).slice(-9)}.0000000000`;

/**
 * A project scope the caller may write, made the way an agent makes one. The
 * marker memory it writes goes into `markers`, for the spec to delete.
 */
export const projectScope = async (
  token: string,
  tag: string,
  markers: string[]
): Promise<string> => {
  const agent = await McpTestClient.connect(token);
  try {
    const made = await agent.callTool('remember', {
      content: `e2e board-mine marker ${tag}: the relay drops frames under load`,
      kind: 'fact',
      project_hint: `/tmp/zm-e2e-${tag}`,
    });
    expect(made.isError ?? false).toBe(false);
    const { scope, memory_id } = firstJson<{
      scope: string;
      memory_id: string;
    }>(made);
    markers.push(memory_id);
    return scope;
  } finally {
    await agent.close();
  }
};

/** Adds a user to a board with a role, and answers their profile id. */
export const makeMember = async (
  scope: string,
  authUserId: string,
  role: 'reader' | 'writer'
): Promise<string> => {
  const { data: profile } = await admin()
    .from('profiles')
    .select('id')
    .eq('user_id', authUserId)
    .single();
  const joined = await admin()
    .from('scope_members')
    .upsert(
      {
        scope,
        user_id: (profile as { id: string }).id,
        role,
        accepted_at: new Date().toISOString(),
      },
      { onConflict: 'scope,user_id' }
    );
  expect(joined.error).toBeNull();
  return (profile as { id: string }).id;
};
