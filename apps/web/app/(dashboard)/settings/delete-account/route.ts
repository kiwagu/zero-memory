import { currentSubjectId } from '@/lib/subject';
import { createAdminClient } from '@/lib/supabase/admin';

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
