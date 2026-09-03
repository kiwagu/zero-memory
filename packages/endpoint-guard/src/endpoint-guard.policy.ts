const TRUE_VALUES = new Set(['1', 'true', 'on', 'yes']);

/**
 * Whether this instance denies user-supplied endpoints (Ollama's
 * `base_url`) that resolve to a private, loopback, or link-local address.
 *
 * Fail-open by construction, matching the rest of the `ZM_POLICY_*` channel:
 * unset or unparseable reads as `false`, the self-host default, because a
 * self-hoster legitimately points Ollama at 127.0.0.1 and a blanket deny
 * would break that. A pooled/managed deployment turns this on explicitly —
 * that is the deployment mode where a user-supplied endpoint on a shared
 * server is a different (and no longer accepted) risk.
 */
export const resolveDenyPrivateEndpoints = (
  env: NodeJS.ProcessEnv = process.env
): boolean =>
  TRUE_VALUES.has(
    (env.ZM_POLICY_DENY_PRIVATE_ENDPOINTS ?? '').trim().toLowerCase()
  );
