/**
 * Creates (idempotently) the local development user used by the MCP server.
 *
 * Required env:
 *   SUPABASE_URL              e.g. http://127.0.0.1:55321
 *   SUPABASE_SERVICE_ROLE_KEY service-role key of the local stack
 *   ZM_EMAIL / ZM_PASSWORD    credentials to provision
 *
 * Usage: bun scripts/create-local-user.ts   (or `make db-create-user`)
 */
import { createClient } from '@supabase/supabase-js';

const url = process.env.SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const email = process.env.ZM_EMAIL;
const password = process.env.ZM_PASSWORD;

if (!url || !serviceRoleKey || !email || !password) {
  console.error(
    'Missing env. Required: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, ZM_EMAIL, ZM_PASSWORD.'
  );
  process.exit(1);
}

const admin = createClient(url, serviceRoleKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const { data, error } = await admin.auth.admin.createUser({
  email,
  password,
  email_confirm: true,
});

if (error) {
  // Already provisioned is a success for an idempotent bootstrap script.
  if (error.code === 'email_exists') {
    console.log(`User ${email} already exists — nothing to do.`);
    process.exit(0);
  }
  console.error(`Failed to create user: ${error.message}`);
  process.exit(1);
}

console.log(`Created user ${email} (${data.user?.id}).`);
