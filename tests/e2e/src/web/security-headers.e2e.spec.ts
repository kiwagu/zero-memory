/**
 * The headers every dashboard response carries: nothing frames the site, the
 * browser never sniffs a type, a page reached over https stays on https, and
 * the framework goes unnamed.
 */
import { expect, test } from '@playwright/test';

test.describe('response headers', () => {
  test('@smoke a page comes with the protective headers and without the framework banner', async ({
    request,
  }) => {
    const response = await request.get('/login');
    expect(response.status()).toBe(200);
    const headers = response.headers();
    expect(headers['content-security-policy']).toBe("frame-ancestors 'none'");
    expect(headers['x-content-type-options']).toBe('nosniff');
    expect(headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
    expect(headers['strict-transport-security']).toBe(
      'max-age=63072000; includeSubDomains'
    );
    expect(headers['x-powered-by']).toBeUndefined();
  });
});
