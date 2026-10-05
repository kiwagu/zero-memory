import {
  revokeConnectedAgent,
  revokeConnectedAgentRequestSchema,
} from '@/lib/connected-agents';
import { currentSubjectId } from '@/lib/subject';

// Reads the caller's session, so it can never be statically cached.
export const dynamic = 'force-dynamic';

/**
 * Revokes one agent the signed-in person approved: the approval is
 * withdrawn, every session minted for that client ends, and the client must
 * be approved again to reconnect.
 *
 * The subject is the verified caller and nothing else; the request names
 * only the client. Agent sessions never reach this handler: the dashboard
 * refuses them before any route runs, so an agent cannot revoke the person's
 * other agents with the account's token.
 */
export async function POST(request: Request): Promise<Response> {
  // Only the dashboard's own page may ask. A missing mark is refused as
  // well, because a same-site sibling origin would otherwise carry the
  // session cookie here.
  if (request.headers.get('sec-fetch-site') !== 'same-origin') {
    return new Response('Refused: not sent from the dashboard.', {
      status: 403,
    });
  }

  const subjectId = await currentSubjectId();
  if (!subjectId) {
    return new Response('Not signed in.', { status: 401 });
  }

  const parsed = revokeConnectedAgentRequestSchema.safeParse(
    await request.json().catch(() => null)
  );
  if (!parsed.success) {
    return new Response('Name the agent to revoke.', { status: 400 });
  }

  try {
    const result = await revokeConnectedAgent(subjectId, parsed.data.clientId);
    if (!result.revoked && result.sessions_ended === 0) {
      return new Response('That agent is not connected to this account.', {
        status: 404,
      });
    }
    return Response.json(result);
  } catch (thrown) {
    // A database message can quote what it was given; log it here, send a
    // fixed sentence over the wire. The revocation is one database step, so
    // a failure changed nothing.
    console.error('revoking an agent failed', {
      message: thrown instanceof Error ? thrown.message : String(thrown),
    });
    return new Response('Revoking failed. Nothing was changed.', {
      status: 500,
    });
  }
}
