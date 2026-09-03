import { describe, expect, it } from 'vitest';

import { externalOrigin } from './external-origin';

const request = (
  headers: Record<string, string>,
  origin = 'https://0.0.0.0:3100'
) => ({
  headers: new Headers(headers),
  nextUrl: { origin },
});

describe('externalOrigin', () => {
  it('prefers the proxy-forwarded host and proto over the internal origin', () => {
    expect(
      externalOrigin(
        request({
          'x-forwarded-host': 'app.zero-memory.com',
          'x-forwarded-proto': 'https',
        })
      )
    ).toBe('https://app.zero-memory.com');
  });

  it('defaults the forwarded proto to https', () => {
    expect(
      externalOrigin(request({ 'x-forwarded-host': 'app.zero-memory.com' }))
    ).toBe('https://app.zero-memory.com');
  });

  it('falls back to the request origin when no proxy headers are present', () => {
    expect(externalOrigin(request({}, 'http://localhost:3100'))).toBe(
      'http://localhost:3100'
    );
  });
});
