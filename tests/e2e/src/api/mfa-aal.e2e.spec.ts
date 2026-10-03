/**
 * What Supabase Auth itself enforces once an account has a second factor.
 *
 * This is a document about the boundary between Auth and the dashboard: the
 * dashboard enforces the second factor on its own pages, and these tests pin
 * which account changes Auth already refuses to a session that has not
 * presented the code (aal1). Two kinds of aal1 session matter: the person's
 * own after a password sign-in, and an agent's, which the authorization
 * server opens with a one-time sign-in link and which never reaches aal2.
 */
import { createClient } from '@supabase/supabase-js';
import { expect, test } from '@playwright/test';

import { e2eEnv } from '../helpers/env.js';
import { claimsOf, enrollTotp } from '../helpers/mfa.js';
import {
  passwordGrantToken,
  provisionE2EUser,
  type E2EUser,
} from '../helpers/users.js';

const admin = () =>
  createClient(e2eEnv.supabaseUrl, e2eEnv.supabaseServiceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

/** A session opened the way the authorization server opens an agent's. */
const agentStyleToken = async (email: string): Promise<string> => {
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
  return data.session.access_token;
};

const putUser = async (accessToken: string, body: unknown) => {
  const response = await fetch(`${e2eEnv.supabaseUrl}/auth/v1/user`, {
    method: 'PUT',
    headers: {
      apikey: e2eEnv.supabaseAnonKey,
      authorization: `Bearer ${accessToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const json = (await response.json().catch(() => ({}))) as {
    error_code?: string;
  };
  return { status: response.status, code: json.error_code ?? null };
};

const enrolFactor = async (accessToken: string) => {
  const response = await fetch(`${e2eEnv.supabaseUrl}/auth/v1/factors`, {
    method: 'POST',
    headers: {
      apikey: e2eEnv.supabaseAnonKey,
      authorization: `Bearer ${accessToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ factor_type: 'totp', friendly_name: 'second' }),
  });
  const json = (await response.json().catch(() => ({}))) as {
    error_code?: string;
  };
  return { status: response.status, code: json.error_code ?? null };
};

test.describe('what Auth enforces once a factor is enrolled', () => {
  let user: E2EUser;

  test.beforeAll(async () => {
    user = await provisionE2EUser(`mfa-aal-${Date.now()}@zm.e2e`);
    const first = await passwordGrantToken(user);
    const enrolled = await enrollTotp(first);
    // Presenting the code raises the session to aal2.
    expect(claimsOf(enrolled.aal2AccessToken).aal).toBe('aal2');
  });

  test('a new password sign-in starts at aal1', async () => {
    const token = await passwordGrantToken(user);
    expect(claimsOf(token).aal).toBe('aal1');
  });

  test('@smoke the person cannot change the password without the code', async () => {
    const token = await passwordGrantToken(user);
    expect(await putUser(token, { password: 'Changed-Passw0rd-1!' })).toEqual({
      status: 401,
      code: 'insufficient_aal',
    });
  });

  test('@smoke an agent cannot change the password', async () => {
    const token = await agentStyleToken(user.email);
    expect(claimsOf(token).aal).toBe('aal1');
    expect(await putUser(token, { password: 'Agent-Passw0rd-1!' })).toEqual({
      status: 401,
      code: 'insufficient_aal',
    });
  });

  test('@smoke an agent cannot change the email', async () => {
    const token = await agentStyleToken(user.email);
    expect(
      await putUser(token, { email: `moved-${Date.now()}@zm.e2e` })
    ).toEqual({ status: 401, code: 'insufficient_aal' });
  });

  test('@smoke an agent cannot enrol a factor of its own', async () => {
    const token = await agentStyleToken(user.email);
    expect(await enrolFactor(token)).toEqual({
      status: 403,
      code: 'insufficient_aal',
    });
  });
});
