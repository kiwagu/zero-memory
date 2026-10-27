const FALSE_VALUES = new Set(['0', 'false', 'off', 'no']);

/**
 * Whether this instance denies user-supplied endpoints (Ollama's
 * `base_url`) that resolve to a private, loopback, or link-local address.
 *
 * Deny is the default: a person can point the server at any address through
 * their own settings, and on an instance shared by several people that is a
 * way into another person's network — the cloud metadata address, a service
 * on the server's own loopback — unless the server refuses it. Unset or
 * unparseable therefore reads as deny. A self-hoster whose Ollama runs on a
 * private address opts out explicitly with
 * `ZM_POLICY_DENY_PRIVATE_ENDPOINTS=false`, a deliberate statement that this
 * instance is one person's.
 */
export const resolveDenyPrivateEndpoints = (
  env: NodeJS.ProcessEnv = process.env
): boolean =>
  !FALSE_VALUES.has(
    (env.ZM_POLICY_DENY_PRIVATE_ENDPOINTS ?? '').trim().toLowerCase()
  );
