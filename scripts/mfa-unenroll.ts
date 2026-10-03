/**
 * Rescue for someone locked out of two-factor authentication — they lost the
 * phone with their authenticator app. Lists the account's factors and, with
 * `--yes`, removes them, so the next sign-in asks only for the first factor
 * and they can turn two-factor on again from Settings.
 *
 * An operator step, run with the service role, after confirming the person's
 * identity out of band: anyone who can run this can take a factor off any
 * account. Preview first, then remove:
 *
 *   SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=… \
 *     bun scripts/mfa-unenroll.ts person@example.com
 *
 *   SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=… \
 *     bun scripts/mfa-unenroll.ts person@example.com --yes
 */
import { createClient } from '@supabase/supabase-js';

const args = Bun.argv.slice(2);
const email = args
  .find((arg) => !arg.startsWith('--'))
  ?.trim()
  .toLowerCase();
const apply = args.includes('--yes');

const url = process.env.SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!email || !url || !serviceRoleKey) {
  console.error(
    'Usage: SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=… ' +
      'bun scripts/mfa-unenroll.ts <email> [--yes]'
  );
  process.exit(2);
}

const admin = createClient(url, serviceRoleKey, {
  auth: { persistSession: false, autoRefreshToken: false },
}).auth.admin;

/** Finds the account by address, page by page through the user list. */
const findUserId = async (address: string): Promise<string | null> => {
  for (let page = 1; ; page += 1) {
    const { data, error } = await admin.listUsers({ page, perPage: 200 });
    if (error) {
      throw new Error(`Could not list users: ${error.message}`);
    }
    const match = data.users.find(
      (user) => user.email?.toLowerCase() === address
    );
    if (match) {
      return match.id;
    }
    if (data.users.length < 200) {
      return null;
    }
  }
};

const userId = await findUserId(email);
if (!userId) {
  console.error(`No account with the address ${email}.`);
  process.exit(1);
}

const { data: listed, error: listError } = await admin.mfa.listFactors({
  userId,
});
if (listError) {
  console.error(`Could not list factors: ${listError.message}`);
  process.exit(1);
}
const factors = listed.factors;
if (factors.length === 0) {
  console.log(`${email} has no second factor; nothing to remove.`);
  process.exit(0);
}
for (const factor of factors) {
  console.log(
    `${factor.id}  ${factor.factor_type}  ${factor.status}  ` +
      `${factor.friendly_name ?? '(unnamed)'}  added ${factor.created_at}`
  );
}
if (!apply) {
  console.log('\nPreview only. Re-run with --yes to remove these factors.');
  process.exit(0);
}
for (const factor of factors) {
  const { error } = await admin.mfa.deleteFactor({ id: factor.id, userId });
  if (error) {
    console.error(`Could not remove ${factor.id}: ${error.message}`);
    process.exit(1);
  }
}
console.log(
  `\nRemoved ${factors.length} factor(s) from ${email}. The next sign-in ` +
    'asks only for the first factor.'
);
