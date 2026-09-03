import { describe, expect, it } from 'vitest';

import { isPrivateIpv4, isPrivateIpv6 } from './endpoint-guard.classify.js';

describe('isPrivateIpv4', () => {
  it.each([
    ['0.0.0.0', true],
    ['0.255.255.255', true],
    ['127.0.0.1', true],
    ['127.255.255.255', true],
    ['10.0.0.1', true],
    ['10.255.255.255', true],
    ['172.16.0.1', true],
    ['172.31.255.255', true],
    ['192.168.1.1', true],
    ['169.254.169.254', true], // cloud metadata endpoint
    ['169.254.0.1', true],
    ['100.64.0.1', true], // carrier-grade NAT, RFC 6598
    ['100.127.255.255', true],
    ['198.18.0.1', true], // benchmarking, RFC 2544
    ['198.19.255.255', true],
  ])('denies %s', (ip, expected) => {
    expect(isPrivateIpv4(ip)).toBe(expected);
  });

  it.each([
    ['8.8.8.8', false],
    ['1.1.1.1', false],
    ['172.15.255.255', false], // just below 172.16/12
    ['172.32.0.0', false], // just above 172.16/12
    ['93.184.216.34', false],
    ['100.63.255.255', false], // just below 100.64/10
    ['100.128.0.0', false], // just above 100.64/10
    ['198.17.255.255', false], // just below 198.18/15
    ['198.20.0.0', false], // just above 198.18/15
  ])('allows %s', (ip, expected) => {
    expect(isPrivateIpv4(ip)).toBe(expected);
  });
});

describe('isPrivateIpv6', () => {
  it.each([
    ['::1', true], // loopback
    ['::', true], // unspecified
    ['fc00::1', true], // unique local
    ['fd12:3456:789a::1', true], // unique local, fd half of fc00::/7
    ['fe80::1', true], // link-local
    ['fe80::abcd:1234', true],
    ['::ffff:127.0.0.1', true], // IPv4-mapped loopback
    ['::ffff:169.254.169.254', true], // IPv4-mapped metadata endpoint
    ['::ffff:10.0.0.1', true], // IPv4-mapped RFC1918
    // The other three spellings of an embedded IPv4 address: one loopback
    // must not become reachable by being written a different way.
    ['::7f00:1', true], // IPv4-compatible (deprecated) 127.0.0.1
    ['::ffff:0:7f00:1', true], // IPv4-translated 127.0.0.1
    ['64:ff9b::7f00:1', true], // NAT64 to 127.0.0.1
    ['64:ff9b::a9fe:a9fe', true], // NAT64 to 169.254.169.254
    // Every IPv4 range is judged through the embedded address, so widening
    // the IPv4 denylist closes its IPv6 spellings in the same move.
    ['::ffff:100.64.0.1', true], // IPv4-mapped carrier-grade NAT
    ['64:ff9b::c612:1', true], // NAT64 to 198.18.0.1
  ])('denies %s', (ip, expected) => {
    expect(isPrivateIpv6(ip)).toBe(expected);
  });

  it.each([
    ['2606:4700:4700::1111', false], // Cloudflare public resolver
    ['2001:db8::1', false],
    ['::ffff:8.8.8.8', false], // IPv4-mapped public address
    ['fbff::1', false], // just below fc00::/7
    ['fe00::1', false], // just below fe80::/10
    ['fec0::1', false], // just above fe80::/10
    ['::8.8.8.8', false], // IPv4-compatible form of a public address
    ['64:ff9b::8.8.8.8', false], // NAT64 to a public address
  ])('allows %s', (ip, expected) => {
    expect(isPrivateIpv6(ip)).toBe(expected);
  });
});
