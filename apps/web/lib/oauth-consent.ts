import { z } from 'zod';

import { serverBaseUrl } from './server-url';

/**
 * The dashboard's side of an agent authorization: the consent page asks the
 * server what a pending request wants, and sends the person's decision back.
 * Both calls carry the person's own dashboard session as the bearer; the
 * server binds the request to whoever opens it first.
 *
 * The wire shapes are restated here rather than imported, because the
 * dashboard bundle cannot import the server packages; the api e2e walks both
 * sides together, so a drift fails there.
 */

/** `oaa_` + the entity-id body: 16 Crockford characters, a dot, 10 more. */
export const AUTHORIZATION_ID_RE =
  /^oaa_[0-9a-hjkmnp-tv-z]{16}\.[0-9a-hjkmnp-tv-z]{10}$/;

const authorizationDetailsSchema = z.object({
  authorization_id: z.string(),
  client: z.object({
    client_id: z.string(),
    client_name: z.string().nullable(),
  }),
  scope: z.string(),
  redirect_uri: z.string(),
  expires_at: z.string(),
});
export type AuthorizationDetails = z.infer<typeof authorizationDetailsSchema>;

/**
 * Schemes the page must never navigate to, whatever the server says: they run
 * script or read local resources. The server already refuses to register
 * them; this is the second lock, because the page hands the URL straight to
 * `location.assign`.
 */
const UNSAFE_SCHEMES = new Set([
  'javascript:',
  'data:',
  'vbscript:',
  'file:',
  'blob:',
]);

export function isSafeRedirect(url: string): boolean {
  try {
    return !UNSAFE_SCHEMES.has(new URL(url).protocol);
  } catch {
    return false;
  }
}

const consentResultSchema = z.object({
  redirect_url: z.string().url().refine(isSafeRedirect),
});

export type ConsentDecision = 'approve' | 'deny';

/**
 * - `details`: the person has to decide;
 * - `redirect`: go back to the client (a code, or `access_denied`);
 * - `gone`: nothing is pending for this person under that id — expired,
 *   already answered, or opened first by someone else;
 * - `failed`: the server could not be reached or answered unexpectedly.
 */
export type ConsentReadResult =
  | { kind: 'details'; details: AuthorizationDetails }
  | { kind: 'redirect'; url: string }
  | { kind: 'gone' }
  | { kind: 'failed' };

export type ConsentDecisionResult = Exclude<
  ConsentReadResult,
  { kind: 'details' }
>;

type Fetch = (
  input: string | URL | Request,
  init?: RequestInit
) => Promise<Response>;

const call = async (
  fetchImpl: Fetch,
  accessToken: string,
  path: string,
  init: RequestInit = {}
): Promise<{ status: number; body: unknown } | null> => {
  try {
    const response = await fetchImpl(`${serverBaseUrl()}${path}`, {
      ...init,
      headers: {
        ...init.headers,
        authorization: `Bearer ${accessToken}`,
        accept: 'application/json',
      },
      cache: 'no-store',
    });
    const body: unknown = await response.json().catch(() => null);
    return { status: response.status, body };
  } catch {
    return null;
  }
};

/** The consent API's own refusal: the flat OAuth error body. */
const consentErrorSchema = z.object({
  error: z.enum(['not_found', 'invalid_request']),
});

/**
 * Anything the consent API would not have said is logged with the address
 * it came from: the usual cause is a dashboard whose `ZM_SERVER_URL` points
 * at another server — one without this API, or one that does not know the
 * request — and the person would otherwise read "expired" for a wiring fault.
 */
const unexpected = (status: number | null): ConsentReadResult => {
  console.warn('oauth consent: unexpected answer from the server', {
    server: serverBaseUrl(),
    status,
  });
  return { kind: 'failed' };
};

const settle = (
  answer: { status: number; body: unknown } | null
): ConsentReadResult => {
  if (answer === null) {
    return unexpected(null);
  }
  if (answer.status === 404 || answer.status === 409) {
    // Only the consent API's own answer means nothing is pending for this
    // person; a bare 404 from a server without the route is a wiring fault.
    return consentErrorSchema.safeParse(answer.body).success
      ? { kind: 'gone' }
      : unexpected(answer.status);
  }
  if (answer.status !== 200) {
    return unexpected(answer.status);
  }
  const redirect = consentResultSchema.safeParse(answer.body);
  if (redirect.success) {
    return { kind: 'redirect', url: redirect.data.redirect_url };
  }
  const details = authorizationDetailsSchema.safeParse(answer.body);
  return details.success
    ? { kind: 'details', details: details.data }
    : unexpected(answer.status);
};

const pathOf = (authorizationId: string): string =>
  `/oauth/authorizations/${encodeURIComponent(authorizationId)}`;

export async function readAuthorization(
  accessToken: string,
  authorizationId: string,
  fetchImpl: Fetch = fetch
): Promise<ConsentReadResult> {
  return settle(await call(fetchImpl, accessToken, pathOf(authorizationId)));
}

export async function decideAuthorization(
  accessToken: string,
  authorizationId: string,
  decision: ConsentDecision,
  fetchImpl: Fetch = fetch
): Promise<ConsentDecisionResult> {
  const result = settle(
    await call(fetchImpl, accessToken, `${pathOf(authorizationId)}/consent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ decision }),
    })
  );
  // A decision never answers with details; that would be a server defect.
  return result.kind === 'details' ? { kind: 'failed' } : result;
}

/**
 * Where the browser goes after the decision, as the screen names it: the
 * host for a web or loopback address, the scheme and host for an app's own
 * URI scheme — what tells a genuine local client from a look-alike.
 */
export function returnHost(redirectUri: string): string {
  try {
    const url = new URL(redirectUri);
    if (url.protocol === 'http:' || url.protocol === 'https:') {
      return url.hostname;
    }
    return url.host ? `${url.protocol}//${url.host}` : url.protocol;
  } catch {
    return redirectUri;
  }
}

/**
 * One line per requested scope, in the person's words: the two scopes this
 * server grants arrive translated; anything else is shown as the token itself
 * rather than hidden.
 */
export function describeScopes(
  scope: string,
  labels: { read: string; write: string }
): string[] {
  const known: Record<string, string> = {
    'mcp:read': labels.read,
    'mcp:write': labels.write,
  };
  return scope
    .split(' ')
    .filter(Boolean)
    .map((token) => known[token] ?? token);
}
