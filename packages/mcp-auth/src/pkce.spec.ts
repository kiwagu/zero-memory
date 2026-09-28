import { randomBytes } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { computeS256Challenge, verifyPkceS256 } from './pkce.js';

const makeVerifier = (): string => randomBytes(32).toString('base64url');

describe('PKCE S256', () => {
  it('accepts the verifier that produced the challenge', () => {
    const verifier = makeVerifier();
    const challenge = computeS256Challenge(verifier);
    expect(verifyPkceS256(verifier, challenge)).toBe(true);
  });

  it('rejects a different verifier', () => {
    const challenge = computeS256Challenge(makeVerifier());
    expect(verifyPkceS256(makeVerifier(), challenge)).toBe(false);
  });

  it('rejects the plain (non-hashed) challenge value as verifier', () => {
    const verifier = makeVerifier();
    const challenge = computeS256Challenge(verifier);
    expect(verifyPkceS256(challenge, challenge)).toBe(false);
  });

  it('fails closed on malformed verifiers (length / charset)', () => {
    const challenge = computeS256Challenge(makeVerifier());
    expect(verifyPkceS256('', challenge)).toBe(false);
    expect(verifyPkceS256('too-short', challenge)).toBe(false);
    expect(verifyPkceS256('!'.repeat(64), challenge)).toBe(false);
    expect(verifyPkceS256('a'.repeat(129), challenge)).toBe(false);
  });

  it('matches the RFC 7636 Appendix B example (base64url, no padding)', () => {
    // The specification's own pair: an oracle independent of this module, so
    // a wrong hash or encoding cannot agree with itself and still pass.
    const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
    const challenge = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';
    expect(computeS256Challenge(verifier)).toBe(challenge);
    expect(verifyPkceS256(verifier, challenge)).toBe(true);
  });
});
