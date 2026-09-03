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
 * Resolve the OAuth issuer from the environment, or throw with a message that
 * names the consequence rather than just the rule.
 */
export const resolvePublicUrl = ({
  raw,
  port,
  trustProxy,
}: ResolvePublicUrlInput): PublicUrlResolution => {
  const warnings: string[] = [];
  const trimmed = raw?.trim() ?? '';

  if (trimmed === '') {
    const message =
      'ZM_PUBLIC_URL is not set, so the OAuth issuer falls back to ' +
      `http://localhost:${port} — an address clients cannot reach. Set it to ` +
      'the exact external HTTPS URL of this server.';
    if (trustProxy) {
      throw new Error(
        `${message} Refusing to start: ZM_TRUST_PROXY=true means this server ` +
          'is deployed behind an edge, where that fallback is never correct.'
      );
    }
    warnings.push(message);
    return { url: `http://localhost:${port}`, warnings };
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(
      `ZM_PUBLIC_URL is not an absolute URL: "${trimmed}". It is the OAuth ` +
        'issuer and is used verbatim, so it must look like ' +
        'https://zm.example.com.'
    );
  }

  if (parsed.username !== '' || parsed.password !== '') {
    throw new Error(
      'ZM_PUBLIC_URL must not carry credentials — the issuer is published in ' +
        'discovery metadata and challenges.'
    );
  }
  if (parsed.search !== '' || parsed.hash !== '') {
    throw new Error(
      `ZM_PUBLIC_URL must be a bare origin, got "${trimmed}". A query or ` +
        'fragment would be baked into every issued token and challenge.'
    );
  }
  // A trailing slash is the one path form we accept, and we normalize it away:
  // the issuer is compared as a string by clients.
  if (parsed.pathname !== '/' && parsed.pathname !== '') {
    throw new Error(
      `ZM_PUBLIC_URL must be a bare origin without a path, got "${trimmed}". ` +
        'The MCP and OAuth routes are served at the root.'
    );
  }

  if (parsed.protocol !== 'https:' && !isLoopbackHost(parsed.hostname)) {
    const message =
      `ZM_PUBLIC_URL uses ${parsed.protocol}// on a non-loopback host ` +
      `(${parsed.hostname}). OAuth requires an HTTPS issuer outside loopback; ` +
      'clients will refuse the flow.';
    if (trustProxy) {
      throw new Error(
        `${message} Refusing to start: terminate TLS at the edge and publish ` +
          'the https URL here.'
      );
    }
    warnings.push(message);
  }

  return { url: `${parsed.protocol}//${parsed.host}`, warnings };
};
