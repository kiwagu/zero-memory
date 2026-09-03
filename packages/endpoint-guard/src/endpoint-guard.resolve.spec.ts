import { beforeEach, describe, expect, it, vi } from 'vitest';

const lookup = vi.fn();
vi.mock('node:dns', () => ({
  promises: { lookup: (...args: unknown[]) => lookup(...args) },
}));

const { resolvePublicAddress, PrivateEndpointError } =
  await import('./endpoint-guard.resolve.js');

describe('resolvePublicAddress', () => {
  // The mock is module-level, so its call count carries between tests and
  // every "never touched DNS" assertion would read the previous test's calls.
  beforeEach(() => {
    lookup.mockReset();
  });

  it('returns an address literal unchanged without touching DNS', async () => {
    await expect(resolvePublicAddress('8.8.8.8')).resolves.toBe('8.8.8.8');
    expect(lookup).not.toHaveBeenCalled();
  });

  it('rejects a private address literal', async () => {
    await expect(resolvePublicAddress('127.0.0.1')).rejects.toBeInstanceOf(
      PrivateEndpointError
    );
  });

  it('resolves a public hostname to its first record', async () => {
    lookup.mockResolvedValueOnce([
      { address: '93.184.216.34', family: 4 },
      { address: '2606:2800:220:1:248:1893:25c8:1946', family: 6 },
    ]);

    await expect(resolvePublicAddress('example.com')).resolves.toBe(
      '93.184.216.34'
    );
  });

  it('rejects when ANY resolved record is private, even if not the first', async () => {
    lookup.mockResolvedValueOnce([
      { address: '8.8.8.8', family: 4 },
      { address: '169.254.169.254', family: 4 },
    ]);

    await expect(
      resolvePublicAddress('attacker.example')
    ).rejects.toBeInstanceOf(PrivateEndpointError);
  });

  it('rejects a name with no records', async () => {
    lookup.mockResolvedValueOnce([]);

    await expect(
      resolvePublicAddress('nowhere.example')
    ).rejects.toBeInstanceOf(PrivateEndpointError);
  });

  // URL.hostname hands an IPv6 literal over still bracketed, and net.isIPv6
  // rejects the brackets — unstripped, these skipped the literal branch and
  // went to DNS, where a private address failed as an unknown name instead.
  it('rejects a bracketed private IPv6 literal as private, not as a DNS failure', async () => {
    await expect(resolvePublicAddress('[::1]')).rejects.toBeInstanceOf(
      PrivateEndpointError
    );
    expect(lookup).not.toHaveBeenCalled();
  });

  it('accepts a bracketed public IPv6 literal and returns it unbracketed', async () => {
    await expect(resolvePublicAddress('[2606:4700:4700::1111]')).resolves.toBe(
      '2606:4700:4700::1111'
    );
    expect(lookup).not.toHaveBeenCalled();
  });

  // Every record here is already checked, so this is about reachability:
  // verbatim order puts AAAA first on Linux, and pinning to it strands a
  // dual-stack host on an IPv4-only Docker network.
  it('prefers an IPv4 record over an earlier IPv6 one', async () => {
    lookup.mockResolvedValueOnce([
      { address: '2606:2800:220:1:248:1893:25c8:1946', family: 6 },
      { address: '93.184.216.34', family: 4 },
    ]);

    await expect(resolvePublicAddress('example.com')).resolves.toBe(
      '93.184.216.34'
    );
  });

  it('falls back to the first record when no IPv4 one is offered', async () => {
    lookup.mockResolvedValueOnce([
      { address: '2606:4700:4700::1111', family: 6 },
    ]);

    await expect(resolvePublicAddress('v6only.example')).resolves.toBe(
      '2606:4700:4700::1111'
    );
  });
});
