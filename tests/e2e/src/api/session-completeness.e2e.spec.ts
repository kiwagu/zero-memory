/**
 * What a second factor protects once an account has one: the data, not only
 * the dashboard pages. A session of such an account reaches its rows — through
 * the database API and through the memory server — once it has given the code,
 * or when the authorization server opened it for an agent and recorded it. A
 * person's own sign-in that has not given the code sees nothing and changes
 * nothing, and an unrecorded first-level session is treated the same way.
 */
import { createClient, type Session } from '@supabase/supabase-js';
import { expect, test } from '@playwright/test';

import { e2eEnv } from '../helpers/env.js';
import { McpTestClient } from '../helpers/mcp.js';
import { claimsOf, enrollTotp } from '../helpers/mfa.js';
import {
  passwordGrantToken,
  provisionE2EUser,
  userRestClient,
  type E2EUser,
} from '../helpers/users.js';

const admin = () =>
  createClient(e2eEnv.supabaseUrl, e2eEnv.supabaseServiceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

/** A session opened the way the authorization server opens an agent's. */
const agentStyleSession = async (email: string): Promise<Session> => {
  const { data: link, error } = await admin().auth.admin.generateLink({
    type: 'magiclink',
    email,
  });
  if (error || !link.properties?.hashed_token) {
    throw new Error(`generateLink failed: ${error?.message}`);
  }
  const anon = createClient(e2eEnv.supabaseUrl, e2eEnv.supabaseAnonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error: verifyError } = await anon.auth.verifyOtp({
    type: 'magiclink',
    token_hash: link.properties.hashed_token,
  });
  if (verifyError || !data.session) {
    throw new Error(`verifyOtp failed: ${verifyError?.message}`);
  }
  return data.session;
};

/** What the authorization server does the moment it mints an agent session. */
const recordAgentSession = async (session: Session, userId: string) => {
  const { error } = await admin()
    .from('agent_sessions')
    .insert({
      session_id: claimsOf(session.access_token).session_id as string,
      user_id: userId,
      client_id: null,
    });
  if (error) {
    throw new Error(`recording the agent session failed: ${error.message}`);
  }
};

/** The first request of an MCP session, sent by hand to read the answer. */
const mcpInitialize = async (accessToken: string) =>
  fetch(`${e2eEnv.serverUrl}/mcp`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${accessToken}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'zm-e2e-completeness', version: '0.1.0' },
      },
    }),
  });

const assuranceOf = async (accessToken: string) => {
  const { data, error } =
    await userRestClient(accessToken).rpc('session_assurance');
  if (error) {
    throw new Error(`session_assurance failed: ${error.message}`);
  }
  return data as {
    aal: string;
    verified_factors: number;
    agent: boolean;
    complete: boolean;
  };
};

test.describe('a session reaches the data only once it is complete', () => {
  let user: E2EUser;
  let aal2Token = '';
  let memoryId = '';

  test.beforeAll(async () => {
    user = await provisionE2EUser(`completeness-${Date.now()}@zm.e2e`);
    const first = await passwordGrantToken(user);
    const enrolled = await enrollTotp(first);
    aal2Token = enrolled.aal2AccessToken;
    // Something of the person's to see — or not to see.
    const mcp = await McpTestClient.connect(aal2Token);
    try {
      const result = await mcp.callTool('remember', {
        content: `completeness fixture ${Date.now()}: the second factor guards the rows themselves`,
        kind: 'fact',
        scope: 'personal',
      });
      const text = result.content.find((c) => c.type === 'text')?.text ?? '';
      memoryId = (JSON.parse(text) as { memory_id: string }).memory_id;
    } finally {
      await mcp.close();
    }
    expect(memoryId).toMatch(/^mem_/);
  });

  test('@smoke the session that gave the code is complete and sees its rows', async () => {
    expect(await assuranceOf(aal2Token)).toMatchObject({
      aal: 'aal2',
      verified_factors: 1,
      agent: false,
      complete: true,
    });
    const { data: profile } = await userRestClient(aal2Token)
      .from('profiles')
      .select('id')
      .eq('user_id', user.id);
    expect(profile).toHaveLength(1);
    const { data: memories } = await userRestClient(aal2Token)
      .from('memories')
      .select('id')
      .eq('id', memoryId);
    expect(memories).toHaveLength(1);
  });

  test('@smoke a sign-in without the code sees nothing and changes nothing', async () => {
    const aal1Token = await passwordGrantToken(user);
    expect(claimsOf(aal1Token).aal).toBe('aal1');
    expect(await assuranceOf(aal1Token)).toMatchObject({
      aal: 'aal1',
      verified_factors: 1,
      agent: false,
      complete: false,
    });

    const rest = userRestClient(aal1Token);
    // Its own profile and memory are invisible: the session identifies nobody.
    const { data: profile } = await rest
      .from('profiles')
      .select('id')
      .eq('user_id', user.id);
    expect(profile).toEqual([]);
    const { data: memories } = await rest
      .from('memories')
      .select('id')
      .eq('id', memoryId);
    expect(memories).toEqual([]);
    // A write reaches no row either.
    const { data: changed } = await rest
      .from('memories')
      .update({ content: 'should not land' })
      .eq('id', memoryId)
      .select('id');
    expect(changed).toEqual([]);
    const { data: untouched } = await admin()
      .from('memories')
      .select('content')
      .eq('id', memoryId)
      .single();
    expect(untouched?.content).toContain('completeness fixture');
  });

  test('@smoke the memory server refuses the session without the code, and says why', async () => {
    const aal1Token = await passwordGrantToken(user);
    const refused = await mcpInitialize(aal1Token);
    expect(refused.status).toBe(401);
    expect(await refused.json()).toMatchObject({ error: 'insufficient_aal' });
    expect(refused.headers.get('www-authenticate')).toContain(
      'two-factor authentication'
    );

    const admitted = await mcpInitialize(aal2Token);
    expect(admitted.status).toBe(200);
  });

  test('@smoke a recorded agent session is complete; an unrecorded first-level one is not', async () => {
    // Opened the way the authorization server opens an agent's, but with no
    // record: a first-level session on an account with a factor.
    const stray = await agentStyleSession(user.email);
    expect(claimsOf(stray.access_token).aal).toBe('aal1');
    expect(await assuranceOf(stray.access_token)).toMatchObject({
      agent: false,
      complete: false,
    });
    expect((await mcpInitialize(stray.access_token)).status).toBe(401);

    // The same kind of session, recorded as the server records what it mints.
    const agent = await agentStyleSession(user.email);
    await recordAgentSession(agent, user.id);
    expect(await assuranceOf(agent.access_token)).toMatchObject({
      aal: 'aal1',
      agent: true,
      complete: true,
    });
    const { data: memories } = await userRestClient(agent.access_token)
      .from('memories')
      .select('id')
      .eq('id', memoryId);
    expect(memories).toHaveLength(1);
    const mcp = await McpTestClient.connect(agent.access_token);
    try {
      expect(await mcp.listToolNames()).toContain('recall');
    } finally {
      await mcp.close();
    }
  });

  test('@smoke an account without a factor owes no code', async () => {
    const plain = await provisionE2EUser(
      `completeness-plain-${Date.now()}@zm.e2e`
    );
    const token = await passwordGrantToken(plain);
    expect(await assuranceOf(token)).toMatchObject({
      aal: 'aal1',
      verified_factors: 0,
      agent: false,
      complete: true,
    });
    expect((await mcpInitialize(token)).status).toBe(200);
  });
});
