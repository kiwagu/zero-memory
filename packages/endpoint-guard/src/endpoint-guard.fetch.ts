import { isIPv6 } from 'node:net';

import { hostnameOf, resolvePublicAddress } from './endpoint-guard.resolve.js';

/** Matches the shape the AI SDK's provider settings accept for `fetch`. */
export type GuardedFetch = typeof fetch;

/**
 * A redirect answered by an endpoint this guard had approved.
 *
 * Its own class because the reason matters to whoever reads the log: the
 * request was refused by policy, not by the endpoint being unreachable.
 */
export class RedirectRefusedError extends Error {
  constructor(
    readonly from: string,
    readonly location: string
  ) {
    super(
      `${from} answered a redirect to ${location}; this instance refuses redirects on a user-supplied endpoint`
    );
    this.name = 'RedirectRefusedError';
  }
}

/**
 * Rewrites `url` to connect directly to `pinnedAddress`, skipping a second
 * DNS lookup. Left unpinned, the runtime resolves the hostname again when
 * the connection actually opens — moments after this module resolved and
 * checked it — and a DNS-rebinding attacker only needs those two lookups to
 * disagree. Connecting to the exact address already checked closes that gap.
 */
const pinnedUrl = (url: URL, pinnedAddress: string): URL => {
  const literal = isIPv6(pinnedAddress) ? `[${pinnedAddress}]` : pinnedAddress;
  const pinned = new URL(url.toString());
  pinned.hostname = literal;
  // The WHATWG URL setter silently no-ops on a host it rejects instead of
  // throwing (verified against this runtime). Falling back to the original,
  // unpinned hostname on a failed pin would quietly defeat the guard, so
  // that case is a hard error instead of a silent pass-through.
  if (pinned.hostname !== literal) {
    throw new Error(
      `endpoint guard: could not pin request to ${pinnedAddress}`
    );
  }
  return pinned;
};

/**
 * Wraps `fetch` so every request first resolves its hostname, rejects one
 * that resolves to a private, loopback, or link-local address
 * ({@link resolvePublicAddress}), and then — for plain HTTP — connects to
 * the exact address just checked rather than letting the runtime resolve
 * the name again.
 *
 * HTTPS requests are checked but not pinned: pinning would send the raw IP
 * as the TLS server name, which a real certificate for a named host does not
 * cover, breaking every legitimate HTTPS endpoint to close a gap that, for
 * HTTPS, is already narrow (this check and the runtime's own resolution
 * happen a function call apart).
 *
 * REDIRECTS ARE REFUSED, and that is the difference between checking an
 * address and actually guarding one. `fetch` follows a cross-host redirect
 * itself, inside a single call, so a checked-and-approved endpoint answering
 * `307 Location: http://169.254.169.254/…` would reach the metadata service
 * with this guard none the wiser — the whole check bypassed by one header.
 * Following them here instead would mean re-implementing per-status method
 * and body semantics correctly, for a protocol (an OpenAI-compatible
 * completions API) where a redirect is not part of any legitimate exchange.
 * So a 3xx is an error rather than a hop.
 */
const denyingFetch: GuardedFetch = (async (input, init) => {
  if (typeof input !== 'string' && !(input instanceof URL)) {
    // The AI SDK only ever calls its `fetch` option with a string URL; a
    // Request object would carry its own headers/body this wrapper does not
    // thread through, so it is refused rather than silently mishandled.
    throw new Error('endpoint guard: Request input is not supported');
  }
  const url = new URL(input);
  const pinnedAddress = await resolvePublicAddress(hostnameOf(url));

  // `manual` keeps the runtime from following a redirect past the address
  // this guard just checked; the 3xx then surfaces here to be refused.
  const guarded: RequestInit = { ...init, redirect: 'manual' };

  const response =
    url.protocol === 'http:'
      ? await (async () => {
          const headers = new Headers(init?.headers);
          // The connection now targets an IP literal, not the original
          // hostname — the server still needs the original name to route.
          if (!headers.has('host')) headers.set('host', url.host);
          return fetch(pinnedUrl(url, pinnedAddress).toString(), {
            ...guarded,
            headers,
          });
        })()
      : await fetch(input, guarded);

  if (response.status >= 300 && response.status < 400) {
    throw new RedirectRefusedError(
      url.host,
      response.headers.get('location') ?? '<no location>'
    );
  }
  return response;
}) as GuardedFetch;

/**
 * Builds the `fetch` a provider client should use, per the instance's
 * egress policy. The self-host default (deny disabled) passes `fetch`
 * straight through — no interception, no DNS lookup, no behaviour change
 * from before this guard existed.
 */
export const createGuardedFetch = (options: {
  readonly denyPrivateEndpoints: boolean;
}): GuardedFetch => (options.denyPrivateEndpoints ? denyingFetch : fetch);
