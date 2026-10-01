/**
 * A return path that is safe to send the browser to after sign-in.
 *
 * The login page and the auth callback both carry a `next` so a guest who was
 * sent to `/login` from a page — or an agent's consent screen — lands back
 * there. That parameter arrives from the URL, so it is attacker-controlled:
 * only a site-root path survives, never an absolute URL or a protocol-relative
 * one, which a browser would happily follow to another host. Anything else,
 * including the absence of a value, resolves to the dashboard root.
 */
export function safeNext(value: string | string[] | undefined): string {
  if (typeof value !== 'string') {
    return '/';
  }
  if (!value.startsWith('/') || value.startsWith('//')) {
    return '/';
  }
  if (value.includes('\\') || value.includes('..')) {
    return '/';
  }
  // A URL parser strips ASCII control characters before it looks at the
  // string, so `/\t/evil.test` is `//evil.test` by the time it is resolved —
  // a host, not a path. None of them belongs in a path the dashboard owns.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(value)) {
    return '/';
  }
  return value;
}
