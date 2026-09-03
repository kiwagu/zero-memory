import { describe, expect, it } from 'vitest';

import {
  isAllowedRedirectUri,
  isRegisteredRedirectUri,
} from './redirect-uri.js';

describe('isAllowedRedirectUri', () => {
  it('allows https anywhere', () => {
    expect(
      isAllowedRedirectUri('https://claude.ai/api/mcp/auth_callback')
    ).toBe(true);
    expect(isAllowedRedirectUri('https://example.com:8443/cb?x=1')).toBe(true);
  });

  it('allows plain http only on loopback hosts', () => {
    expect(isAllowedRedirectUri('http://localhost/callback')).toBe(true);
    expect(isAllowedRedirectUri('http://localhost:41241/callback')).toBe(true);
    expect(isAllowedRedirectUri('http://127.0.0.1:8080/cb')).toBe(true);
    expect(isAllowedRedirectUri('http://[::1]:9000/cb')).toBe(true);
    expect(isAllowedRedirectUri('http://example.com/cb')).toBe(false);
    expect(isAllowedRedirectUri('http://192.168.1.10/cb')).toBe(false);
    // Lookalike subdomain must not pass the loopback exemption.
    expect(isAllowedRedirectUri('http://localhost.evil.com/cb')).toBe(false);
  });

  it('allows private-use URI schemes for native apps (RFC 8252 §7.1)', () => {
    // Cursor's desktop deep-link — the case this unblocks.
    expect(
      isAllowedRedirectUri('cursor://anysphere.cursor-mcp/oauth/callback')
    ).toBe(true);
    // Reverse-domain private-use scheme (the RFC's recommended shape).
    expect(isAllowedRedirectUri('com.example.app:/oauth/callback')).toBe(true);
    expect(isAllowedRedirectUri('vscode://ms.something/cb')).toBe(true);
  });

  it('rejects dangerous pseudo-schemes even as private-use', () => {
    expect(isAllowedRedirectUri('javascript:alert(1)')).toBe(false);
    expect(isAllowedRedirectUri('data:text/html,evil')).toBe(false);
    expect(isAllowedRedirectUri('vbscript:msgbox(1)')).toBe(false);
    expect(isAllowedRedirectUri('file:///etc/passwd')).toBe(false);
    expect(isAllowedRedirectUri('blob:https://x/uuid')).toBe(false);
  });

  it('rejects fragments, credentials, and garbage', () => {
    expect(isAllowedRedirectUri('cursor://host/cb#fragment')).toBe(false);
    expect(isAllowedRedirectUri('cursor://user:pw@host/cb')).toBe(false);
    expect(isAllowedRedirectUri('https://example.com/cb#fragment')).toBe(false);
    expect(isAllowedRedirectUri('https://user:pw@example.com/cb')).toBe(false);
    expect(isAllowedRedirectUri('not a url')).toBe(false);
    expect(isAllowedRedirectUri('')).toBe(false);
  });
});

describe('isRegisteredRedirectUri', () => {
  it('requires an exact string match', () => {
    const registered = ['http://127.0.0.1:8080/cb'];
    expect(
      isRegisteredRedirectUri('http://127.0.0.1:8080/cb', registered)
    ).toBe(true);
    expect(
      isRegisteredRedirectUri('http://127.0.0.1:8080/cb/extra', registered)
    ).toBe(false);
    expect(
      isRegisteredRedirectUri('http://127.0.0.1:8080/CB', registered)
    ).toBe(false);
  });

  it('matches loopback http regardless of port (RFC 8252 §7.3)', () => {
    const registered = ['http://127.0.0.1:32857/callback'];
    expect(
      isRegisteredRedirectUri('http://127.0.0.1:41999/callback', registered)
    ).toBe(true);
    expect(
      isRegisteredRedirectUri('http://127.0.0.1/callback', registered)
    ).toBe(true);
    // Host, path, and query must still match exactly.
    expect(
      isRegisteredRedirectUri('http://localhost:41999/callback', registered)
    ).toBe(false);
    expect(
      isRegisteredRedirectUri('http://127.0.0.1:41999/other', registered)
    ).toBe(false);
    expect(
      isRegisteredRedirectUri('http://127.0.0.1:41999/callback?x=1', registered)
    ).toBe(false);
  });

  it('never relaxes the port for https or non-loopback hosts', () => {
    expect(
      isRegisteredRedirectUri('https://example.com:8443/cb', [
        'https://example.com:9443/cb',
      ])
    ).toBe(false);
    expect(
      isRegisteredRedirectUri('http://192.168.1.10:8080/cb', [
        'http://192.168.1.10:9090/cb',
      ])
    ).toBe(false);
  });
});
