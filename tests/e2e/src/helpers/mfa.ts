/**
 * Second-factor helpers: enrol an authenticator app for a user over the Auth
 * REST API, and compute its codes the way a phone would.
 */
import { Secret, TOTP } from 'otpauth';

import { e2eEnv } from './env.js';

const totpFor = (secret: string): TOTP =>
  new TOTP({
    secret: Secret.fromBase32(secret),
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
  });

/**
 * The current code for a secret. Pass the code used last to get one from the
 * next 30-second window instead: Auth accepts a code once, so a second
 * verification in the same window needs to wait for a new one.
 */
export const totpCode = async (
  secret: string,
  notThis?: string
): Promise<string> => {
  const totp = totpFor(secret);
  for (;;) {
    const code = totp.generate();
    if (code !== notThis) {
      return code;
    }
    const msLeft = 30_000 - (Date.now() % 30_000);
    await new Promise((resolve) => setTimeout(resolve, msLeft + 250));
  }
};

const authFetch = async (
  path: string,
  accessToken: string,
  body: unknown
): Promise<{ status: number; json: Record<string, unknown> }> => {
  const response = await fetch(`${e2eEnv.supabaseUrl}/auth/v1${path}`, {
    method: 'POST',
    headers: {
      apikey: e2eEnv.supabaseAnonKey,
      authorization: `Bearer ${accessToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const json = (await response.json().catch(() => ({}))) as Record<
    string,
    unknown
  >;
  return { status: response.status, json };
};

export interface EnrolledTotp {
  factorId: string;
  secret: string;
  /** The code that verified the factor; the next one must differ. */
  lastCode: string;
  /** The session the verification raised to aal2. */
  aal2AccessToken: string;
}

/** Enrols and verifies a TOTP factor for the session's user. */
export const enrollTotp = async (
  accessToken: string,
  friendlyName = 'e2e authenticator'
): Promise<EnrolledTotp> => {
  const enrolled = await authFetch('/factors', accessToken, {
    factor_type: 'totp',
    friendly_name: friendlyName,
  });
  if (enrolled.status !== 200) {
    throw new Error(`enrol failed: ${enrolled.status}`);
  }
  const factorId = enrolled.json.id as string;
  const secret = (enrolled.json.totp as { secret: string }).secret;
  const verified = await verifyTotp(accessToken, factorId, secret);
  return { factorId, secret, ...verified };
};

/** A challenge and its verification; returns the aal2 session's token. */
export const verifyTotp = async (
  accessToken: string,
  factorId: string,
  secret: string,
  notThis?: string
): Promise<{ lastCode: string; aal2AccessToken: string }> => {
  const challenge = await authFetch(
    `/factors/${factorId}/challenge`,
    accessToken,
    {}
  );
  if (challenge.status !== 200) {
    throw new Error(`challenge failed: ${challenge.status}`);
  }
  const code = await totpCode(secret, notThis);
  const verified = await authFetch(`/factors/${factorId}/verify`, accessToken, {
    challenge_id: challenge.json.id,
    code,
  });
  if (verified.status !== 200) {
    throw new Error(`verify failed: ${verified.status}`);
  }
  return {
    lastCode: code,
    aal2AccessToken: verified.json.access_token as string,
  };
};

/** The JWT's claims, read without verification (Auth already did that). */
export const claimsOf = (accessToken: string): Record<string, unknown> =>
  JSON.parse(
    Buffer.from(accessToken.split('.')[1] ?? '', 'base64url').toString('utf8')
  ) as Record<string, unknown>;
