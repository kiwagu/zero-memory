import { promises as dns } from 'node:dns';
import { isIPv4, isIPv6 } from 'node:net';

import { isPrivateIpv4, isPrivateIpv6 } from './endpoint-guard.classify.js';

export class PrivateEndpointError extends Error {
  constructor(
    readonly hostname: string,
    readonly address: string
  ) {
    super(
      `"${hostname}" resolves to ${address}, a private/loopback/link-local address — this instance denies private endpoints`
    );
    this.name = 'PrivateEndpointError';
  }
}

/**
 * The host to resolve, as a bare name or address.
 *
 * `URL.hostname` returns an IPv6 literal STILL BRACKETED (`[::1]`), and
 * `net.isIPv6` rejects the brackets — so passing it through unchanged sent
 * every IPv6 literal down the DNS path, where it failed as an unknown name.
 * That turned a public IPv6 endpoint into an error and a private one into
 * the wrong error, so the brackets come off here, once, for every caller.
 */
const unbracketed = (host: string): string =>
  host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;

export const hostnameOf = (url: URL): string => unbracketed(url.hostname);

const isPrivateAddress = (address: string): boolean =>
  isIPv4(address) ? isPrivateIpv4(address) : isPrivateIpv6(address);

/**
 * Resolves `hostname` and returns one address safe to connect to.
 *
 * Every resolved address is checked, not just the first: a client is free to
 * connect to any record a name returns, so an attacker publishing a public
 * address alongside a private one would still pass a first-record-only
 * check. Throws {@link PrivateEndpointError} the moment any resolved address
 * — or the hostname itself, when it is already a literal — is private,
 * loopback, or link-local.
 *
 * Of the surviving records an IPv4 one is preferred. Every record here has
 * already been checked, so the choice is about reachability rather than
 * safety: `verbatim` keeps the resolver's order, which on Linux commonly
 * puts AAAA first, and pinning to that would strand a dual-stack host on the
 * IPv4-only networks Docker hands out by default.
 */
export const resolvePublicAddress = async (
  rawHostname: string
): Promise<string> => {
  // Stripped here too, not only in `hostnameOf`: a caller reaching this
  // directly with a bracketed literal would otherwise skip the literal
  // branch entirely and have a private address treated as an unknown name.
  const hostname = unbracketed(rawHostname);
  if (isIPv4(hostname) || isIPv6(hostname)) {
    if (isPrivateAddress(hostname)) {
      throw new PrivateEndpointError(hostname, hostname);
    }
    return hostname;
  }

  const records = await dns.lookup(hostname, { all: true, verbatim: true });
  if (records.length === 0) {
    throw new PrivateEndpointError(hostname, '<no address>');
  }
  for (const record of records) {
    if (isPrivateAddress(record.address)) {
      throw new PrivateEndpointError(hostname, record.address);
    }
  }
  const preferred =
    records.find((record) => isIPv4(record.address)) ?? records[0]!;
  return preferred.address;
};
