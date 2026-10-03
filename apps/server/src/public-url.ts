/**
 * The public URL is the OAuth issuer. It is embedded verbatim in the
 * authorization-server metadata, in every `WWW-Authenticate` challenge and in
 * the registrations clients keep — so if it does not match the URL clients
 * actually reach, every client breaks at once, and it breaks SILENTLY: the
 * server boots happily, only the clients fail, and re-pointing it later
 * invalidates whatever tokens survived. That makes it the one setting worth
 * refusing to start over, which is what this module decides.
 *
 * Two tiers, deliberately:
 *
 * - **Always fatal** — a value that is set but malformed (not absolute, or
 *   carrying a path, query, fragment or credentials). There is no deployment
 *   in which those are intended; they are typos that would be baked into
 *   metadata.
 * - **Fatal only behind an edge** — a missing value, or a non-HTTPS scheme on
 *   a non-loopback host. `ZM_TRUST_PROXY` is the honest signal for "this is a
 *   real deployment behind our reverse proxy" (the prod env sets it), so the
 *   same condition that is a plain local default in development is a
 *   deployment defect there. Off the edge, they only warn — a developer on
 *   `http://localhost:8787` must never be blocked.
 */

/** Outcome of resolving the issuer: the URL plus anything worth logging. */
export interface PublicUrlResolution {
  url: string;
  warnings: string[];
}

export interface ResolvePublicUrlInput {
  /** Raw `ZM_PUBLIC_URL`; empty and whitespace-only count as unset. */
  raw?: string | undefined;
  /** Listening port, used only for the development default. */
  port: number;
  /** `ZM_TRUST_PROXY` — true means the server sits behind our TLS edge. */
  trustProxy: boolean;
}

const isLoopbackHost = (hostname: string): boolean =>
  hostname === 'localhost' ||
  hostname === '127.0.0.1' ||
  hostname === '::1' ||
  hostname === '[::1]';

/**
 * What differs between the external origins this server is told about: the
 * variable's name, the address used when it is unset, and the consequence each
 * defect has, so every error says why it matters for that variable.
 */
interface ExternalOriginSpec {
  name: string;
  fallback: string;
  unset: string;
  example: string;
  credentials: string;
  queryOrFragment: string;
  path: string;
  plainHttp: string;
  plainHttpBehindEdge: string;
}

/**
 * The shared two-tier validator: malformed is always fatal; missing, or plain
 * http on a public host, is fatal only behind the edge.
 */
const resolveExternalOrigin = (
  spec: ExternalOriginSpec,
  raw: string | undefined,
  trustProxy: boolean
): PublicUrlResolution => {
  const warnings: string[] = [];
  const trimmed = raw?.trim() ?? '';

  if (trimmed === '') {
    const message = `${spec.name} is not set, so ${spec.unset}`;
    if (trustProxy) {
      throw new Error(
        `${message} Refusing to start: ZM_TRUST_PROXY=true means this server ` +
          'is deployed behind an edge, where that fallback is never correct.'
      );
    }
    warnings.push(message);
    return { url: spec.fallback, warnings };
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(
      `${spec.name} is not an absolute URL: "${trimmed}". ${spec.example}`
    );
  }

  if (parsed.username !== '' || parsed.password !== '') {
    throw new Error(
      `${spec.name} must not carry credentials — ${spec.credentials}`
    );
  }
  if (parsed.search !== '' || parsed.hash !== '') {
    throw new Error(
      `${spec.name} must be a bare origin, got "${trimmed}". ${spec.queryOrFragment}`
    );
  }
  // A trailing slash is the one path form we accept, and we normalize it away:
  // both origins are compared and concatenated as strings.
  if (parsed.pathname !== '/' && parsed.pathname !== '') {
    throw new Error(
      `${spec.name} must be a bare origin without a path, got "${trimmed}". ` +
        spec.path
    );
  }

  if (parsed.protocol !== 'https:' && !isLoopbackHost(parsed.hostname)) {
    const message =
      `${spec.name} uses ${parsed.protocol}// on a non-loopback host ` +
      `(${parsed.hostname}). ${spec.plainHttp}`;
    if (trustProxy) {
      throw new Error(
        `${message} Refusing to start: ${spec.plainHttpBehindEdge}`
      );
    }
    warnings.push(message);
  }

  return { url: `${parsed.protocol}//${parsed.host}`, warnings };
};

/**
 * Resolve the OAuth issuer from the environment, or throw with a message that
 * names the consequence rather than just the rule.
 */
export const resolvePublicUrl = ({
  raw,
  port,
  trustProxy,
}: ResolvePublicUrlInput): PublicUrlResolution =>
  resolveExternalOrigin(
    {
      name: 'ZM_PUBLIC_URL',
      fallback: `http://localhost:${port}`,
      unset:
        `the OAuth issuer falls back to http://localhost:${port} — an ` +
        'address clients cannot reach. Set it to the exact external HTTPS ' +
        'URL of this server.',
      example:
        'It is the OAuth issuer and is used verbatim, so it must look like ' +
        'https://zm.example.com.',
      credentials:
        'the issuer is published in discovery metadata and challenges.',
      queryOrFragment:
        'A query or fragment would be baked into every issued token and ' +
        'challenge.',
      path: 'The MCP and OAuth routes are served at the root.',
      plainHttp:
        'OAuth requires an HTTPS issuer outside loopback; clients will ' +
        'refuse the flow.',
      plainHttpBehindEdge:
        'terminate TLS at the edge and publish the https URL here.',
    },
    raw,
    trustProxy
  );

export interface ResolveWebUrlInput {
  /** Raw `ZM_WEB_URL`; empty and whitespace-only count as unset. */
  raw?: string | undefined;
  /** `ZM_TRUST_PROXY` — true means the server sits behind our TLS edge. */
  trustProxy: boolean;
}

/** The dashboard a developer runs next to this server (`bun run dev`). */
const LOCAL_DASHBOARD = 'http://localhost:3100';

/**
 * Resolve the dashboard's external origin. The authorization endpoint sends
 * the person there to sign in and approve a client, so a wrong value strands
 * every new agent connection on a page that does not exist.
 */
export const resolveWebUrl = ({
  raw,
  trustProxy,
}: ResolveWebUrlInput): PublicUrlResolution =>
  resolveExternalOrigin(
    {
      name: 'ZM_WEB_URL',
      fallback: LOCAL_DASHBOARD,
      unset:
        `agents are sent to ${LOCAL_DASHBOARD} to sign in and approve ` +
        'access. Set it to the exact external URL of the dashboard.',
      example: 'It must look like https://app.example.com.',
      credentials: 'it is sent to every browser that connects an agent.',
      queryOrFragment:
        'The consent page appends its own query, which would collide.',
      path: 'The consent page is served at the dashboard root.',
      plainHttp: 'People would sign in to approve agents over plain http.',
      plainHttpBehindEdge: "publish the dashboard's https URL here.",
    },
    raw,
    trustProxy
  );
