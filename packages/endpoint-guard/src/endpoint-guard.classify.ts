/**
 * IP-range classification for the egress guard.
 *
 * Every range here is one an outbound request must never reach when the
 * instance denies private endpoints — loopback, RFC1918 private space, and
 * link-local (which is where cloud metadata endpoints live, e.g.
 * 169.254.169.254). No parsing library: the ranges are few and fixed, and a
 * SEV-relevant check like this is easier to audit as ~10 lines of bit math
 * than as a dependency.
 */

interface CidrRange {
  readonly base: bigint;
  readonly prefixLength: number;
}

const ipv4ToInt = (ip: string): bigint =>
  ip.split('.').reduce((acc, octet) => (acc << 8n) | BigInt(Number(octet)), 0n);

const ipv4Range = (cidr: string): CidrRange => {
  const [address, length] = cidr.split('/');
  return { base: ipv4ToInt(address!), prefixLength: Number(length) };
};

const inRange = (value: bigint, range: CidrRange, width: number): boolean => {
  const shift = BigInt(width - range.prefixLength);
  return value >> shift === range.base >> shift;
};

/**
 * Networks denied under IPv4. 0.0.0.0/8 is not in the card's original list
 * but is the same bypass class as loopback — many stacks treat it as "this
 * host" — so it is included alongside 127.0.0.0/8 rather than left as a gap.
 */
const IPV4_DENYLIST: readonly CidrRange[] = [
  ipv4Range('0.0.0.0/8'),
  ipv4Range('127.0.0.0/8'),
  ipv4Range('10.0.0.0/8'),
  ipv4Range('172.16.0.0/12'),
  ipv4Range('192.168.0.0/16'),
  ipv4Range('169.254.0.0/16'),
  // Carrier-grade NAT (RFC 6598). Not private space in the RFC1918 sense,
  // but on a shared server it addresses exactly what this guard exists to
  // keep out of reach: the operator's own overlay network — a Tailscale
  // peer sits here — and the pod space some managed Kubernetes hands out.
  // It is denied only where the policy is on, so a self-hoster reaching
  // their own Ollama across a tailnet is unaffected by this line.
  ipv4Range('100.64.0.0/10'),
  // Benchmarking (RFC 2544): never a real destination, routinely wired to
  // something local on a lab host.
  ipv4Range('198.18.0.0/15'),
];

export const isPrivateIpv4 = (ip: string): boolean => {
  const value = ipv4ToInt(ip);
  return IPV4_DENYLIST.some((range) => inRange(value, range, 32));
};

/**
 * Expands an IPv6 literal to its full 128-bit value.
 *
 * Handles `::` compression and a trailing embedded IPv4 literal
 * (`::ffff:127.0.0.1`), which is the classic bypass of a filter that only
 * understands one address family.
 */
const expandIpv6 = (address: string): bigint => {
  const withoutZone = address.split('%')[0]!;
  const [head, tail] = withoutZone.includes('::')
    ? withoutZone.split('::')
    : [withoutZone, ''];

  const toGroups = (part: string): string[] =>
    part === '' ? [] : part.split(':');

  const expandEmbeddedIpv4 = (groups: string[]): string[] => {
    const last = groups.at(-1);
    if (last === undefined || !last.includes('.')) return groups;
    const ipInt = ipv4ToInt(last);
    return [
      ...groups.slice(0, -1),
      ((ipInt >> 16n) & 0xffffn).toString(16),
      (ipInt & 0xffffn).toString(16),
    ];
  };

  const headGroups = expandEmbeddedIpv4(toGroups(head!));
  const tailGroups = expandEmbeddedIpv4(toGroups(tail ?? ''));
  const missing = 8 - (headGroups.length + tailGroups.length);
  const middle = Array<string>(Math.max(missing, 0)).fill('0');

  return [...headGroups, ...middle, ...tailGroups].reduce(
    (acc, group) =>
      (acc << 16n) | BigInt(parseInt(group === '' ? '0' : group, 16)),
    0n
  );
};

const ipv6Range = (base: string, prefixLength: number): CidrRange => ({
  base: expandIpv6(base),
  prefixLength,
});

/**
 * fe80::/10 (link-local) is not in the card's literal list either — it is
 * IPv6's direct counterpart to 169.254.0.0/16, present on every interface by
 * default, and omitting it would leave the same metadata-adjacent class of
 * address reachable whenever a resolver hands back an AAAA record.
 */
const IPV6_DENYLIST: readonly CidrRange[] = [
  ipv6Range('::', 128),
  ipv6Range('::1', 128),
  ipv6Range('fc00::', 7),
  ipv6Range('fe80::', 10),
];

/**
 * The /96 prefixes that carry a real IPv4 address in their low 32 bits.
 *
 * `::ffff:a.b.c.d` is the familiar one, and checking only it left the other
 * three spellings of the same address classed as public: `::7f00:1` and
 * `::ffff:0:7f00:1` are both 127.0.0.1, and the NAT64 prefix reaches
 * whatever IPv4 address a translator is pointed at. Each is judged by the
 * address it embeds, so one loopback cannot pass by being written
 * differently. Derived from literals rather than hand-computed constants —
 * the expansion is the same code the classifier itself trusts.
 */
const IPV4_EMBEDDING_PREFIXES: readonly bigint[] = [
  expandIpv6('::') >> 32n, // IPv4-compatible, ::a.b.c.d (deprecated)
  expandIpv6('::ffff:0:0') >> 32n, // IPv4-mapped
  expandIpv6('::ffff:0:0:0') >> 32n, // IPv4-translated
  expandIpv6('64:ff9b::') >> 32n, // NAT64 well-known prefix
];

export const isPrivateIpv6 = (ip: string): boolean => {
  const value = expandIpv6(ip);
  // The IPv6 ranges answer first, so ::1 is refused as loopback in its own
  // right rather than by way of the address it would embed.
  if (IPV6_DENYLIST.some((range) => inRange(value, range, 128))) return true;
  if (IPV4_EMBEDDING_PREFIXES.some((prefix) => value >> 32n === prefix)) {
    return IPV4_DENYLIST.some((range) =>
      inRange(value & 0xffffffffn, range, 32)
    );
  }
  return false;
};
