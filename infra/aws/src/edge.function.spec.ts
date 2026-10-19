import { describe, expect, it } from 'vitest';

import { COOKIE_BUDGET, VIEWER_REQUEST_SOURCE } from './edge.function.js';

type Field = { value: string; multiValue?: { value: string }[] };
type Fields = Record<string, Field>;
type Result = {
  statusCode?: number;
  headers: Fields;
  cookies?: Record<string, { value: string; attributes?: string }>;
  uri?: string;
};

// The function as CloudFront runs it: its own source, evaluated.
const handler = new Function(`${VIEWER_REQUEST_SOURCE}\nreturn handler;`)() as (
  event: unknown
) => Result;

const run = (
  cookies: Fields,
  querystring: Fields = {},
  uri = '/oauth/consent'
): Result =>
  handler({
    viewer: { ip: '203.0.113.7' },
    request: {
      method: 'GET',
      uri,
      querystring,
      headers: { host: { value: 'app.example.com' } },
      cookies,
    },
  });

const session = (ref: string, bytes: number): Fields => ({
  [`sb-${ref}-auth-token.0`]: { value: 'a'.repeat(bytes / 2) },
  [`sb-${ref}-auth-token.1`]: { value: 'b'.repeat(bytes / 2) },
});

describe('viewer-request function', () => {
  it('passes a request with one session through, naming the viewer and host', () => {
    const result = run(session('current', 4000));
    expect(result.statusCode).toBeUndefined();
    expect(result.uri).toBe('/oauth/consent');
    expect(result.headers['x-viewer-address']).toEqual({
      value: '203.0.113.7',
    });
    expect(result.headers['x-forwarded-host']).toEqual({
      value: 'app.example.com',
    });
  });

  it('sends a browser carrying two sessions back to the same address with every session cookie expired', () => {
    const result = run(
      {
        ...session('old', 5000),
        ...session('current', 5000),
        theme: { value: 'dark' },
      },
      {
        authorization_id: { value: 'oaa_test' },
        // As CloudFront passes it: split into fields, still percent-encoded.
        next: { value: '%2Fa%20b%3Fc%3Dd%26e' },
      }
    );
    expect(result.statusCode).toBe(303);
    expect(result.headers.location).toEqual({
      value:
        'https://app.example.com/oauth/consent?authorization_id=oaa_test&next=%2Fa%20b%3Fc%3Dd%26e',
    });
    expect(result.headers['cache-control']).toEqual({ value: 'no-store' });
    expect(Object.keys(result.cookies ?? {}).sort()).toEqual([
      'sb-current-auth-token.0',
      'sb-current-auth-token.1',
      'sb-old-auth-token.0',
      'sb-old-auth-token.1',
    ]);
    for (const cookie of Object.values(result.cookies ?? {})) {
      expect(cookie).toEqual({
        value: '',
        attributes: 'Path=/; Max-Age=0; Secure; SameSite=Lax',
      });
    }
  });

  it('counts every value of a repeated cookie and every value of a repeated parameter', () => {
    const repeated: Fields = {
      'sb-x-auth-token': {
        value: 'a'.repeat(3000),
        multiValue: [
          { value: 'a'.repeat(3000) },
          { value: 'b'.repeat(3000) },
          { value: 'c'.repeat(3000) },
        ],
      },
    };
    const result = run(repeated, {
      tag: { value: 'one', multiValue: [{ value: 'one' }, { value: 'two' }] },
    });
    expect(result.statusCode).toBe(303);
    expect(result.headers.location).toEqual({
      value: 'https://app.example.com/oauth/consent?tag=one&tag=two',
    });
  });

  it('leaves large cookies alone when none of them is a session cookie', () => {
    const result = run({ other: { value: 'x'.repeat(COOKIE_BUDGET + 100) } });
    expect(result.statusCode).toBeUndefined();
  });

  it('never redirects off the host, whatever the path looks like', () => {
    const big = { ...session('old', 6000), ...session('current', 6000) };
    for (const uri of [
      '//attacker.example/landing',
      '/\\attacker.example',
      '/@attacker.example',
    ]) {
      const location = run(big, {}, uri).headers.location?.value ?? '';
      expect(location).toBe(`https://app.example.com${uri}`);
      expect(new URL(location).host).toBe('app.example.com');
    }
  });

  it('keeps the address without a query when there is none', () => {
    const result = run({
      ...session('old', 6000),
      ...session('current', 6000),
    });
    expect(result.headers.location).toEqual({
      value: 'https://app.example.com/oauth/consent',
    });
  });
});
