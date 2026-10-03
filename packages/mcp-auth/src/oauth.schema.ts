import { entityIdSchemas } from '@workspace/contracts';
import { z } from 'zod';

/** OAuth scopes advertised and granted by this authorization server (v1). */
export const MCP_SCOPES = 'mcp:read mcp:write';

/**
 * A registered OAuth client id: a branded `oac_` entity id. Incoming client_ids
 * (authorize/token) are parsed against this — not trusted as a raw string.
 */
export const clientIdSchema = entityIdSchemas.oauth_client.schema;
export type ClientId = z.infer<typeof clientIdSchema>;

/** RFC 7591 dynamic client registration request (public clients only). */
export const clientRegistrationRequestSchema = z.object({
  client_name: z.string().min(1).max(256).optional(),
  redirect_uris: z.array(z.string().min(1)).min(1),
  token_endpoint_auth_method: z.literal('none').default('none'),
  // Advisory fields some clients send; accepted and ignored.
  grant_types: z.array(z.string()).optional(),
  response_types: z.array(z.string()).optional(),
  scope: z.string().optional(),
});
export type ClientRegistrationRequest = z.infer<
  typeof clientRegistrationRequestSchema
>;

/** OAuth 2.1 authorization request (query of GET /oauth/authorize). */
export const authorizeRequestSchema = z.object({
  client_id: clientIdSchema,
  redirect_uri: z.string().min(1),
  response_type: z.literal('code'),
  // 43-128 chars of base64url per RFC 7636.
  code_challenge: z.string().min(43).max(128),
  code_challenge_method: z.literal('S256'),
  state: z.string().max(2048).optional(),
  // RFC 8707 resource indicator (the MCP endpoint URL).
  resource: z.string().optional(),
  scope: z.string().optional(),
});
export type AuthorizeRequest = z.infer<typeof authorizeRequestSchema>;

/**
 * A pending authorization: a branded `oaa_` entity id. The dashboard receives
 * it in the consent URL and sends it back; it is parsed, never trusted raw.
 */
export const authorizationIdSchema = entityIdSchemas.oauth_authorization.schema;
export type AuthorizationId = z.infer<typeof authorizationIdSchema>;

/** POST /oauth/authorizations/:id/consent — what the person decided. */
export const consentDecisionSchema = z.object({
  decision: z.enum(['approve', 'deny']),
});
export type ConsentDecision = z.infer<typeof consentDecisionSchema>;

/**
 * GET /oauth/authorizations/:id while the person still has to decide: what
 * the consent screen shows. `client_name` is whatever the client registered
 * itself as, so it is untrusted text.
 */
export const authorizationDetailsSchema = z.object({
  authorization_id: authorizationIdSchema,
  client: z.object({
    client_id: clientIdSchema,
    client_name: z.string().nullable(),
  }),
  scope: z.string(),
  redirect_uri: z.string(),
  expires_at: z.string(),
});
export type AuthorizationDetails = z.infer<typeof authorizationDetailsSchema>;

/**
 * Where the browser goes next: the client's redirect URI carrying a code or
 * an error. Returned by a decision, and by a read when a stored consent
 * already covers the request.
 */
export const consentResultSchema = z.object({ redirect_url: z.string().url() });
export type ConsentResult = z.infer<typeof consentResultSchema>;

/** POST /oauth/authorize = authorization request + the login credentials. */
export const authorizeSubmitSchema = authorizeRequestSchema.extend({
  email: z.string().min(3).max(320),
  password: z.string().min(1).max(1024),
});
export type AuthorizeSubmit = z.infer<typeof authorizeSubmitSchema>;

/** POST /oauth/token — authorization_code grant. */
export const authorizationCodeGrantSchema = z.object({
  grant_type: z.literal('authorization_code'),
  code: z.string().min(1),
  code_verifier: z.string().min(1),
  client_id: clientIdSchema,
  redirect_uri: z.string().min(1),
  resource: z.string().optional(),
});

/** POST /oauth/token — refresh_token grant. */
export const refreshTokenGrantSchema = z.object({
  grant_type: z.literal('refresh_token'),
  refresh_token: z.string().min(1),
  client_id: clientIdSchema.optional(),
  scope: z.string().optional(),
  resource: z.string().optional(),
});

export const tokenRequestSchema = z.discriminatedUnion('grant_type', [
  authorizationCodeGrantSchema,
  refreshTokenGrantSchema,
]);
export type TokenRequest = z.infer<typeof tokenRequestSchema>;

/** Successful token response (RFC 6749 §5.1). */
export interface TokenResponse {
  access_token: string;
  token_type: 'bearer';
  expires_in: number;
  refresh_token: string;
  scope: string;
}

/** OAuth error response (RFC 6749 §5.2). */
export interface OAuthErrorBody {
  error: string;
  error_description?: string;
}
