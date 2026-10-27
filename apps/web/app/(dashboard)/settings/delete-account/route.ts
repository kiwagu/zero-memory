import { readAssurance, secondFactorRefusal } from '@/lib/mfa';
import { currentSubjectId } from '@/lib/subject';
import { createAdminClient } from '@/lib/supabase/admin';
import { createServerSupabaseClient } from '@/lib/supabase/server';

// Reads the caller's session, so it can never be statically cached.
export const dynamic = 'force-dynamic';

/**
 * Erases the signed-in user's own account — the one place it can happen. The
 * memory server offers agents no way to delete an account, so a person does
 * it here, signed in to the dashboard.
 *
 * The subject is the verified caller and nothing else: no id is accepted from
 * the request. The erasure (`hard_delete_user`) removes everything the account
 * owns, severs what other people's rows say about it, records a content-free
 * audit row and deletes the sign-in principal, which ends every session of the
 * user at the source; the client still clears its own cookies afterwards. It
 * spans rows past row-level security and removes the auth user, so it runs on
 * the service role, from this server only.
 *
 * It must be the person, not an agent acting as them. An agent holds a real
 * session of the same account and could present it here, so the session
 * itself has to prove something an agent cannot: the code from the account's
 * authenticator app (`aal2`). Agent sessions never reach that level, and once
 * an account has a factor Auth refuses them a password or email change and a
 * factor of their own, so they cannot get there by another road.
 */
export async function POST(request: Request): Promise<Response> {
  // Only the dashboard's own page may ask. Every current browser marks where
  // a request comes from; a missing mark is refused as well, because a
  // same-site sibling origin would otherwise carry the session cookie here.
  if (request.headers.get('sec-fetch-site') !== 'same-origin') {
    return new Response('Refused: not sent from the dashboard.', {
      status: 403,
    });
  }

  const subjectId = await currentSubjectId();
  if (!subjectId) {
    return new Response('Not signed in.', { status: 401 });
  }

  const supabase = await createServerSupabaseClient();
  const refused = await secondFactorRefusal(supabase);
  if (refused) {
    return refused;
  }
  // Without a factor there is nothing an agent lacks, so deletion waits until
  // the person turns one on.
  const { verifiedFactors } = await readAssurance(supabase);
  if (verifiedFactors === 0) {
    return new Response(
      'Turn on two-factor authentication first: deleting the account is ' +
        'confirmed with a code from your authenticator app.',
      { status: 403 }
    );
  }

  const admin = createAdminClient();
  if (!admin) {
    return new Response(
      'Account deletion is not configured on this server: ' +
        'SUPABASE_SERVICE_ROLE_KEY is missing.',
      { status: 500 }
    );
  }

  const { data, error } = await admin.rpc('hard_delete_user', {
    p_user_id: subjectId,
  });
  if (error) {
    // A database message can quote what it was given; log it here, send a
    // fixed sentence over the wire.
    console.error('account deletion failed', { message: error.message });
    return new Response('Account deletion failed. Nothing was deleted.', {
      status: 500,
    });
  }
  return Response.json(data);
}
