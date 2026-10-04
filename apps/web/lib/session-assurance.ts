import { z } from 'zod';

import { safeNext } from './safe-next';

/**
 * The calling session's standing, as the database states it: the assurance
 * level of its token, how many verified factors the account has (every type,
 * counted the same way the memory server counts them), whether the
 * authorization server opened the session for an agent, and whether it may
 * reach the data at all. Pure helpers only, so the request proxy can use
 * them without pulling in the server-only modules.
 */
export const sessionAssuranceSchema = z.object({
  aal: z.string(),
  verified_factors: z.number().int().nonnegative(),
  agent: z.boolean(),
  complete: z.boolean(),
});

export type SessionAssurance = z.infer<typeof sessionAssuranceSchema>;

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

/** The answer a request gets when its session was opened for an agent. */
export const AGENT_SESSION_REFUSAL =
  'Refused: this session was opened for a connected agent, not for a ' +
  'person. Sign in yourself.';

/** The answer a request made by code gets while the session owes the code. */
export const SECOND_FACTOR_REFUSAL =
  'Enter the code from your authenticator app first.';

/** The answer a request gets when the session cannot be checked. */
export const ASSURANCE_UNAVAILABLE =
  'Your session could not be checked right now. Try again.';
