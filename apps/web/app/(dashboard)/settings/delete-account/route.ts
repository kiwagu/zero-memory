import { deleteAccountViaServer } from '@/lib/mcp';
import { createServerSupabaseClient } from '@/lib/supabase/server';

// Reads the caller's session, so it can never be statically cached.
export const dynamic = 'force-dynamic';

/**
 * Erases the signed-in user's own account. The deletion runs through the
 * server's audited `delete_account` tool, which always erases the authenticated
 * caller (no subject is sent), so this endpoint cannot target another account.
 * The cascade removes the sign-in principal too, which invalidates every session
 * of the user at the source; the client still clears its own cookies and
 * redirects to the login page afterwards.
 */
export async function POST(): Promise<Response> {
  const supabase = await createServerSupabaseClient();
  const accessToken = (await supabase.auth.getSession()).data.session
    ?.access_token;
  if (!accessToken) {
    return new Response('Not signed in.', { status: 401 });
  }

  try {
    const result = await deleteAccountViaServer(accessToken);
    return Response.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return new Response(`Account deletion failed: ${message}`, { status: 500 });
  }
}
