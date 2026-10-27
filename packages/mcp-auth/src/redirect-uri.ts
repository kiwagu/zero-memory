/**
 * Redirect URI policy for dynamically registered (public) clients, covering the
 * three RFC 8252 redirect methods for native apps: https anywhere, plain http
 * on loopback hosts, and private-use URI schemes (custom app deep-links such as
 * `cursor://…`). A fragment, embedded credentials, or a dangerous pseudo-scheme
 * always fails closed. Private-use schemes are safe here because PKCE S256 is
 * mandatory in the DCR flow: an app that hijacks the scheme still cannot redeem
 * an intercepted code without the verifier (RFC 8252 §8.1).
 */

// WHATWG URL keeps the brackets on IPv6 hostnames.
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

// Pseudo-schemes that execute script or read local resources — never a
// legitimate redirect target, so they stay rejected even as private-use.
const DANGEROUS_SCHEMES = new Set([
  'javascript:',
  'data:',
  'vbscript:',
  'file:',
  'blob:',
]);

export const isAllowedRedirectUri = (raw: string): boolean => {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.hash !== '' || url.username !== '' || url.password !== '') {
    return false;
  }
  if (url.protocol === 'https:') {
    return true;
  }
  if (url.protocol === 'http:') {
    // `hostname` strips the port but keeps IPv6 brackets.
    return LOOPBACK_HOSTS.has(url.hostname);
  }
  // RFC 8252 §7.1 private-use URI scheme (native-app deep-link). Any non-http
  // scheme that is not an executable/local-resource pseudo-scheme qualifies.
  return !DANGEROUS_SCHEMES.has(url.protocol);
};

/**
 * A client returns either to remote hosts (https) or to the local machine
 * (loopback http, or a private-use scheme its app owns), never both. The
 * consent screen names the one address a request returns to, and a remembered
 * approval is tied to that address; a registration that spans both kinds
 * would put a remote host behind a client whose screen can look entirely
 * local. Each URI is expected to have passed `isAllowedRedirectUri` already.
 */
export const mixesRemoteAndLocal = (
  redirectUris: readonly string[]
): boolean => {
  let remote = false;
  let local = false;
  for (const raw of redirectUris) {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      continue;
    }
    if (url.protocol === 'https:') {
      remote = true;
    } else {
      local = true;
    }
  }
  return remote && local;
};

/**
 * Match against the client's registered redirect URIs: exact for https, but
 * loopback http compares ignoring the port (RFC 8252 §7.3 — native clients
 * bind an ephemeral port per authorization, so the port MUST NOT be pinned).
 */
export const isRegisteredRedirectUri = (
  redirectUri: string,
  registered: string[]
): boolean => {
  if (registered.includes(redirectUri)) {
    return true;
  }
  let candidate: URL;
  try {
    candidate = new URL(redirectUri);
  } catch {
    return false;
  }
  if (
    candidate.protocol !== 'http:' ||
    !LOOPBACK_HOSTS.has(candidate.hostname)
  ) {
    return false;
  }
  return registered.some((raw) => {
    let reg: URL;
    try {
      reg = new URL(raw);
    } catch {
      return false;
    }
    return (
      reg.protocol === 'http:' &&
      reg.hostname === candidate.hostname &&
      reg.pathname === candidate.pathname &&
      reg.search === candidate.search
    );
  });
};
