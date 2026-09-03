import { createHash, timingSafeEqual } from 'node:crypto';

/** RFC 7636 §4.1: 43-128 chars of [A-Za-z0-9-._~]. */
const CODE_VERIFIER_PATTERN = /^[A-Za-z0-9\-._~]{43,128}$/;

/** S256 code challenge for a verifier: base64url(sha256(verifier)). */
export const computeS256Challenge = (verifier: string): string =>
  createHash('sha256').update(verifier, 'ascii').digest('base64url');

/**
 * Verifies a PKCE S256 code_verifier against the stored code_challenge.
 * Constant-time comparison; malformed verifiers fail closed.
 */
export const verifyPkceS256 = (
  verifier: string,
  challenge: string
): boolean => {
  if (!CODE_VERIFIER_PATTERN.test(verifier)) {
    return false;
  }
  const computed = Buffer.from(computeS256Challenge(verifier), 'utf8');
  const expected = Buffer.from(challenge, 'utf8');
  return (
    computed.length === expected.length && timingSafeEqual(computed, expected)
  );
};
