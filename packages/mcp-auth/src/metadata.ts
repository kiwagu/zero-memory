import { MCP_SCOPES } from './oauth.schema.js';

const SCOPES_SUPPORTED = MCP_SCOPES.split(' ');

/** RFC 8414 authorization server metadata. */
export const authorizationServerMetadata = (issuer: string) => ({
  issuer,
  authorization_endpoint: `${issuer}/oauth/authorize`,
  token_endpoint: `${issuer}/oauth/token`,
  registration_endpoint: `${issuer}/oauth/register`,
  response_types_supported: ['code'],
  grant_types_supported: ['authorization_code', 'refresh_token'],
  // Public clients only: PKCE S256 is mandatory, no client secrets.
  code_challenge_methods_supported: ['S256'],
  token_endpoint_auth_methods_supported: ['none'],
  scopes_supported: SCOPES_SUPPORTED,
});

/** RFC 9728 protected resource metadata for the /mcp endpoint. */
export const protectedResourceMetadata = (issuer: string) => ({
  resource: `${issuer}/mcp`,
  authorization_servers: [issuer],
  scopes_supported: SCOPES_SUPPORTED,
  bearer_methods_supported: ['header'],
});

/** URL advertised in 401 challenges (RFC 9728 §5.1 / MCP auth spec). */
export const resourceMetadataUrl = (issuer: string): string =>
  `${issuer}/.well-known/oauth-protected-resource/mcp`;
