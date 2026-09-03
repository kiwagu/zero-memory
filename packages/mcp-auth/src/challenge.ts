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
