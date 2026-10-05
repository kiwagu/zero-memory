import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

import { entityIdSchemas } from '@workspace/contracts';

/**
 * The refresh token the authorization server hands to an agent:
 * `<grant id>~<generation>~<signature>`. The grant id says which approval it
 * stands for, the generation how many times it was rotated, and the signature
 * — HMAC-SHA256 with the grant's own secret over the first two parts — that
 * the server issued it. Nothing secret is stored about the token itself: the
 * server recomputes it from the grant, which is what lets two refreshes that
 * raced both leave with the token of the generation that won.
 */

const SEPARATOR = '~';

export interface ParsedGrantToken {
  grantId: string;
  generation: number;
  signature: string;
}

/** A fresh per-grant signing secret. */
export const newGrantSecret = (): string =>
  randomBytes(32).toString('base64url');

const sign = (secret: string, grantId: string, generation: number): string =>
  createHmac('sha256', secret)
    .update(`${grantId}${SEPARATOR}${generation}`)
    .digest('base64url');

/** The refresh token of this grant at this generation. */
export const grantToken = (
  grantId: string,
  generation: number,
  secret: string
): string =>
  [grantId, String(generation), sign(secret, grantId, generation)].join(
    SEPARATOR
  );

/** Reads a token's parts; null for anything that is not one of ours. */
export const parseGrantToken = (token: string): ParsedGrantToken | null => {
  const parts = token.split(SEPARATOR);
  if (parts.length !== 3) {
    return null;
  }
  const [grantId, generation, signature] = parts as [string, string, string];
  if (
    !entityIdSchemas.agent_grant.is(grantId) ||
    !/^(0|[1-9][0-9]{0,8})$/.test(generation) ||
    signature === ''
  ) {
    return null;
  }
  return { grantId, generation: Number(generation), signature };
};

/** Whether the server issued this token with this grant's secret. */
export const grantTokenIsSigned = (
  parsed: ParsedGrantToken,
  secret: string
): boolean => {
  const expected = Buffer.from(sign(secret, parsed.grantId, parsed.generation));
  const presented = Buffer.from(parsed.signature);
  return (
    expected.length === presented.length && timingSafeEqual(expected, presented)
  );
};
