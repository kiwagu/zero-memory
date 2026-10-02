import { describe, expect, it } from 'vitest';

import { safeNext } from './safe-next';

describe('safeNext', () => {
  it('keeps a site-root path with its query', () => {
    expect(safeNext('/oauth/consent?authorization_id=oaa_x')).toBe(
      '/oauth/consent?authorization_id=oaa_x'
    );
  });

  it('keeps the dashboard root', () => {
    expect(safeNext('/')).toBe('/');
  });

  it('refuses a protocol-relative address', () => {
    expect(safeNext('//evil.test/x')).toBe('/');
  });

  it('refuses an absolute URL', () => {
    expect(safeNext('https://evil.test/x')).toBe('/');
  });

  it('refuses a backslash-escaped host', () => {
    expect(safeNext('/\\evil.test')).toBe('/');
  });

  it('refuses a relative path', () => {
    expect(safeNext('settings')).toBe('/');
  });

  it('refuses control characters that a URL parser would strip into a host', () => {
    // `new URL('/\t/evil.test', base)` drops the tab and lands on evil.test.
    expect(safeNext('/\t/evil.test')).toBe('/');
    expect(safeNext('/\n/evil.test')).toBe('/');
    expect(safeNext('/\r/evil.test')).toBe('/');
    expect(safeNext('/settings\u0000')).toBe('/');
    expect(safeNext('/\u007f/evil.test')).toBe('/');
  });

  it('falls back when nothing or several values arrive', () => {
    expect(safeNext(undefined)).toBe('/');
    expect(safeNext(['/a', '/b'])).toBe('/');
    expect(safeNext('')).toBe('/');
  });
});
