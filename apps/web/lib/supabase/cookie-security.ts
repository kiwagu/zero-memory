/**
 * Whether the session cookie may travel only over https. Behind the edge the
 * browser's scheme arrives as `X-Forwarded-Proto`; a stand reached over plain
 * http (development, e2e) has none, and a cookie marked Secure there would
 * never come back, so the mark follows the scheme the browser used.
 */
export const secureCookies = (headers: Headers): boolean =>
  headers.get('x-forwarded-proto')?.split(',')[0]?.trim() === 'https';
