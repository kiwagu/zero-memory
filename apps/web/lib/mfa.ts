import { redirect } from 'next/navigation';

import {
  AGENT_SESSION_REFUSAL,
  ASSURANCE_UNAVAILABLE,
  SECOND_FACTOR_REFUSAL,
  assuranceGap,
  sessionAssuranceSchema,
  verifyPathFor,
} from './session-assurance';
import type { createServerSupabaseClient } from './supabase/server';

export {
  assuranceGap,
  verifyPathFor,
  type AssuranceGap,
} from './session-assurance';

/**
 * The second factor, as the dashboard enforces it.
 *
 * The database holds the rule: on an account with a verified factor, a
 * session reaches the data once it has given the code (`aal2`), and a session
 * the authorization server opened for an agent reaches it without one. The
 * dashboard asks for that standing before it renders or acts, so a person
 * who still owes the code is sent to give it instead of seeing empty pages,
 * and an agent's session presented to the dashboard is refused outright.
 */

type ServerSupabase = Awaited<ReturnType<typeof createServerSupabaseClient>>;

export interface Assurance {
  aal: string | undefined;
  verifiedFactors: number;
  /** Opened by the authorization server for an agent; never a person's. */
  agent: boolean;
  /** May reach the data: the code was given, or none is owed. */
  complete: boolean;
}

/**
 * The session's standing, asked of the database now: the factors come from
 * the account rather than from the session cookie, so a factor added in
 * another browser applies here at once. When the database cannot say, this
 * throws rather than report "no factor" — a lookup that fails must never open
 * what the factor guards.
 */
export async function readAssurance(
  supabase: ServerSupabase
): Promise<Assurance> {
  const { data, error } = await supabase.rpc('session_assurance');
  const parsed = error ? null : sessionAssuranceSchema.safeParse(data);
  if (!parsed?.success) {
    throw new Error(ASSURANCE_UNAVAILABLE);
  }
  return {
    aal: parsed.data.aal,
    verifiedFactors: parsed.data.verified_factors,
    agent: parsed.data.agent,
    complete: parsed.data.complete,
  };
}

/**
 * For pages behind the second factor: sends a session that owes the code to
 * `/mfa/verify`, which brings it back to `nextPath` afterwards. The request
 * proxy already did this for every dashboard path; a page that renders
 * through another route keeps the same check here.
 */
export async function requireAssurance(
  supabase: ServerSupabase,
  nextPath: string
): Promise<void> {
  const { aal, verifiedFactors, agent } = await readAssurance(supabase);
  if (agent) {
    throw new Error(AGENT_SESSION_REFUSAL);
  }
  if (assuranceGap(aal, verifiedFactors) === 'verify') {
    redirect(verifyPathFor(nextPath));
  }
}

/**
 * For route handlers that change the account with the service role, where
 * the page gate does not reach: a session that owes the code is refused, and
 * so is one whose standing cannot be checked right now. Null means go ahead.
 */
export async function secondFactorRefusal(
  supabase: ServerSupabase
): Promise<Response | null> {
  let assurance: Assurance;
  try {
    assurance = await readAssurance(supabase);
  } catch {
    return new Response(ASSURANCE_UNAVAILABLE, { status: 503 });
  }
  if (assurance.agent) {
    return new Response(AGENT_SESSION_REFUSAL, { status: 403 });
  }
  if (assuranceGap(assurance.aal, assurance.verifiedFactors) === 'verify') {
    return new Response(SECOND_FACTOR_REFUSAL, { status: 403 });
  }
  return null;
}
