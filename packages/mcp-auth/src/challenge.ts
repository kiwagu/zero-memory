import { resourceMetadataUrl } from './metadata.js';

/**
 * WWW-Authenticate challenge pointing clients at the protected resource
 * metadata, per the MCP authorization spec.
 */
export const buildWwwAuthenticate = (
  issuer: string,
  errorDescription?: string
): string => {
  const parts = [
    'Bearer error="invalid_token"',
    ...(errorDescription
      ? [`error_description="${errorDescription.replaceAll('"', "'")}"`]
      : []),
    `resource_metadata="${resourceMetadataUrl(issuer)}"`,
  ];
  return parts.join(', ');
};

/**
 * 401 for a live token whose session has not completed sign-in: the account
 * has a second factor and this session never gave the code, and it is not one
 * the authorization server opened for an agent. Answered as `invalid_token`
 * rather than as a 403, because the useful next step for a client is to
 * authorize again — the person signs in with the code, and the session the
 * client then receives is an agent's, which is complete.
 */
export const incompleteSessionResponse = (issuer: string): Response => {
  const errorDescription =
    'This account uses two-factor authentication and this session has not ' +
    'given the code. Authorize the client again to receive a session of its own.';
  return new Response(
    JSON.stringify({
      error: 'insufficient_aal',
      error_description: errorDescription,
    }),
    {
      status: 401,
      headers: {
        'content-type': 'application/json',
        'www-authenticate': buildWwwAuthenticate(issuer, errorDescription),
      },
    }
  );
};

/** 401 response used by the MCP transport for unauthenticated requests. */
export const unauthorizedResponse = (
  issuer: string,
  errorDescription = 'Authorization required'
): Response =>
  new Response(
    JSON.stringify({
      error: 'invalid_token',
      error_description: errorDescription,
    }),
    {
      status: 401,
      headers: {
        'content-type': 'application/json',
        'www-authenticate': buildWwwAuthenticate(issuer, errorDescription),
      },
    }
  );
