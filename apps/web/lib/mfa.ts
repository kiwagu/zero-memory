import { redirect } from 'next/navigation';

import { safeNext } from './safe-next';
import type { createServerSupabaseClient } from './supabase/server';

/**
 * The second factor, as the dashboard enforces it.
 *
 * Enforcement lives here, in the pages people use, and never in row-level
 * security: the sessions agents receive are opened without a person and stay
 * at the first level (`aal1`) by design, so a database rule demanding `aal2`
 * would stop every agent. What the factor protects is the person's own way
 * in: the dashboard, the consent screen that grants agents, and the changes
 * only a person should make.
 */

export type AssuranceGap = 'none' | 'verify';

/**
 * Whether this session still owes the code: only an account that has a
 * verified factor, and only until the session presented it (`aal2`).
 */
export function assuranceGap(
  aal: string | undefined,
  verifiedFactors: number
): AssuranceGap {
  return verifiedFactors > 0 && aal !== 'aal2' ? 'verify' : 'none';
}

/** Where the code is asked for, with the page to return to afterwards. */
export function verifyPathFor(nextPath: string): string {
  const next = safeNext(nextPath);
  return next === '/'
    ? '/mfa/verify'
    : `/mfa/verify?next=${encodeURIComponent(next)}`;
}

type ServerSupabase = Awaited<ReturnType<typeof createServerSupabaseClient>>;

/**
 * The session's level and the account's verified factors, both asked of Auth
 * now: the factors come from the user record rather than the session cookie,
 * so a factor added in another browser applies here at once. When Auth cannot
 * say, this throws rather than report "no factor" — a lookup that fails must
 * never open what the factor guards.
 */
export async function readAssurance(
  supabase: ServerSupabase
): Promise<{ aal: string | undefined; verifiedFactors: number }> {
  const [{ data: claimsData }, { data: factors, error }] = await Promise.all([
    supabase.auth.getClaims(),
    supabase.auth.mfa.listFactors(),
  ]);
  if (error || !factors) {
    throw new Error('The second factor could not be checked right now.');
  }
  const aal = claimsData?.claims?.aal;
  return {
    aal: typeof aal === 'string' ? aal : undefined,
    verifiedFactors: factors.totp.filter(
      (factor) => factor.status === 'verified'
    ).length,
  };
}

/**
 * For pages behind the second factor: sends a session that owes the code to
 * `/mfa/verify`, which brings it back to `nextPath` afterwards.
 */
export async function requireAssurance(
  supabase: ServerSupabase,
  nextPath: string
): Promise<void> {
  const { aal, verifiedFactors } = await readAssurance(supabase);
  if (assuranceGap(aal, verifiedFactors) === 'verify') {
    redirect(verifyPathFor(nextPath));
  }
}

/**
 * For route handlers that change the account with the service role, where
 * the page gate does not reach: a session that owes the code is refused, and
 * so is one whose factors cannot be checked right now. Null means go ahead.
 */
export async function secondFactorRefusal(
  supabase: ServerSupabase
): Promise<Response | null> {
  let assurance: Awaited<ReturnType<typeof readAssurance>>;
  try {
    assurance = await readAssurance(supabase);
  } catch {
    return new Response(
      'Your second factor could not be checked right now. Try again.',
      { status: 503 }
    );
  }
  if (assuranceGap(assurance.aal, assurance.verifiedFactors) === 'verify') {
    return new Response('Enter the code from your authenticator app first.', {
      status: 403,
    });
  }
  return null;
}
