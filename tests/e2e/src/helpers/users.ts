/**
 * Dedicated, throwaway e2e accounts. Provisioning is idempotent and guarded:
 * it refuses to touch anything but the reserved e2e emails, so the dev/admin
 * account (and its memories) can never be clobbered by a test run.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import { e2eEnv } from './env.js';

export interface E2EUser {
  id: string;
  email: string;
  password: string;
}

const assertE2EEmail = (email: string): void => {
  if (!email.endsWith('@zm.e2e')) {
    throw new Error(
      `Refusing to provision "${email}": e2e accounts must use the @zm.e2e ` +
        'domain so real users (admin/dev) are never touched.'
    );
  }
};

const adminClient = (): SupabaseClient =>
  createClient(e2eEnv.supabaseUrl, e2eEnv.supabaseServiceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

/** Creates the user if missing, otherwise re-syncs the known e2e password. */
export const provisionE2EUser = async (email: string): Promise<E2EUser> => {
  assertE2EEmail(email);
  const admin = adminClient();
  const created = await admin.auth.admin.createUser({
    email,
    password: e2eEnv.password,
    email_confirm: true,
  });
  if (!created.error) {
    return { id: created.data.user.id, email, password: e2eEnv.password };
  }
  if (created.error.code !== 'email_exists') {
    throw new Error(`Failed to create ${email}: ${created.error.message}`);
  }
  const { data: list, error: listError } = await admin.auth.admin.listUsers({
    page: 1,
    perPage: 200,
  });
  if (listError) {
    throw new Error(`Failed to list users: ${listError.message}`);
  }
  const existing = list.users.find((user) => user.email === email);
  if (!existing) {
    throw new Error(`User ${email} exists but was not found via admin API.`);
  }
  const updated = await admin.auth.admin.updateUserById(existing.id, {
    password: e2eEnv.password,
  });
  if (updated.error) {
    throw new Error(
      `Failed to sync password for ${email}: ${updated.error.message}`
    );
  }
  return { id: existing.id, email, password: e2eEnv.password };
};

/**
 * Deterministic sign-in for e2e: the Supabase password grant (the same
 * infrastructure scripts/zm-login's OAuth flow ends up on), no interactive
 * OAuth in setup. The returned JWT is accepted by the MCP HTTP transport.
 */
export const passwordGrantToken = async (user: E2EUser): Promise<string> => {
  const anon = createClient(e2eEnv.supabaseUrl, e2eEnv.supabaseAnonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await anon.auth.signInWithPassword({
    email: user.email,
    password: user.password,
  });
  if (error || !data.session) {
    throw new Error(
      `Password grant failed for ${user.email}: ${error?.message ?? 'no session'}`
    );
  }
  return data.session.access_token;
};

/** PostgREST client acting as the given user (RLS enforced by the JWT). */
export const userRestClient = (accessToken: string): SupabaseClient =>
  createClient(e2eEnv.supabaseUrl, e2eEnv.supabaseAnonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
  });
