'use server';

import { z } from 'zod';

import {
  AUTHORIZATION_ID_RE,
  decideAuthorization,
  type ConsentDecisionResult,
} from './oauth-consent';
import { createServerSupabaseClient } from './supabase/server';

const decisionInputSchema = z.object({
  authorizationId: z.string().regex(AUTHORIZATION_ID_RE),
  decision: z.enum(['approve', 'deny']),
});

/**
 * Sends the person's decision on an agent's authorization request to the
 * server, under their own dashboard session, and returns where the browser
 * goes next. The page navigates itself: the destination is the client's own
 * redirect URI, which may be an app's private scheme a server redirect could
 * not reach.
 */
export async function decideConsent(
  authorizationId: string,
  decision: 'approve' | 'deny'
): Promise<ConsentDecisionResult> {
  const input = decisionInputSchema.safeParse({ authorizationId, decision });
  if (!input.success) {
    return { kind: 'gone' };
  }
  const supabase = await createServerSupabaseClient();
  const { data } = await supabase.auth.getSession();
  const accessToken = data.session?.access_token;
  if (!accessToken) {
    return { kind: 'failed' };
  }
  return decideAuthorization(
    accessToken,
    input.data.authorizationId,
    input.data.decision
  );
}
