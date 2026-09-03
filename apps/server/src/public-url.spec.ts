import { describe, expect, it } from 'vitest';

import { resolvePublicUrl } from './public-url.js';

const behindEdge = { port: 8787, trustProxy: true };
const local = { port: 8787, trustProxy: false };

describe('resolvePublicUrl', () => {
  it('normalizes a valid external URL to a bare origin', () => {
    expect(
      resolvePublicUrl({ raw: 'https://zm.example.com/', ...behindEdge })
    ).toEqual({ url: 'https://zm.example.com', warnings: [] });
  });

  it('keeps a non-default port in the origin', () => {
    expect(
      resolvePublicUrl({ raw: 'https://zm.example.com:8443', ...behindEdge })
        .url
    ).toBe('https://zm.example.com:8443');
  });

  it('defaults to loopback in development, with a warning', () => {
    const result = resolvePublicUrl({ raw: undefined, ...local });
    expect(result.url).toBe('http://localhost:8787');
    expect(result.warnings).toHaveLength(1);
  });

  it('treats blank as unset', () => {
    expect(resolvePublicUrl({ raw: '   ', ...local }).url).toBe(
      'http://localhost:8787'
    );
  });

  it('refuses to start behind an edge without a public URL', () => {
    expect(() => resolvePublicUrl({ raw: '', ...behindEdge })).toThrow(
      /ZM_TRUST_PROXY=true/
    );
  });

  it('allows plain http on loopback anywhere', () => {
    expect(
      resolvePublicUrl({ raw: 'http://localhost:8787', ...behindEdge })
    ).toEqual({ url: 'http://localhost:8787', warnings: [] });
  });

  it('refuses plain http on a public host behind an edge', () => {
    expect(() =>
      resolvePublicUrl({ raw: 'http://zm.example.com', ...behindEdge })
    ).toThrow(/HTTPS issuer/);
  });

  it('only warns about plain http off the edge', () => {
    const result = resolvePublicUrl({ raw: 'http://zm.example.com', ...local });
    expect(result.url).toBe('http://zm.example.com');
    expect(result.warnings).toHaveLength(1);
  });

  it.each([
    ['not absolute', 'zm.example.com'],
    ['with a path', 'https://zm.example.com/mcp'],
    ['with a query', 'https://zm.example.com?a=1'],
    ['with a fragment', 'https://zm.example.com#x'],
    ['with credentials', 'https://user:pass@zm.example.com'],
  ])('always rejects a malformed value (%s)', (_case, raw) => {
    expect(() => resolvePublicUrl({ raw, ...local })).toThrow();
  });
});
