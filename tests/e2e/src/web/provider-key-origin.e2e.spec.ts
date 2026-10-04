/**
 * The provider-key route answers the settings page and nobody else. A request
 * that does not carry the browser's same-origin mark, or whose body is not
 * JSON, is refused before anything is read — the same door account deletion
 * closes.
 */
import { expect, test } from '@playwright/test';

import { readSeedState } from '../helpers/runtime-state.js';
import { signInThroughForm } from '../helpers/web.js';

test.describe('the provider-key route and where a request comes from', () => {
  test('@smoke a request without the dashboard’s own mark is refused unread', async ({
    page,
  }) => {
    const seed = await readSeedState();
    await signInThroughForm(page, seed.userB);

    // Signed in, with the session cookie, but not marked as the page's own.
    const unmarked = await page.request.post('/settings/provider-key', {
      data: { provider: 'ollama', baseUrl: 'https://example.com/v1' },
    });
    expect(unmarked.status()).toBe(403);
    expect(await unmarked.text()).toContain('dashboard');

    // Marked, but a form-shaped body rather than JSON.
    const asText = await page.request.post('/settings/provider-key', {
      headers: {
        'sec-fetch-site': 'same-origin',
        'content-type': 'text/plain',
      },
      data: JSON.stringify({
        provider: 'ollama',
        baseUrl: 'https://example.com/v1',
      }),
    });
    expect(asText.status()).toBe(403);

    const revoke = await page.request.delete('/settings/provider-key');
    expect(revoke.status()).toBe(403);
  });
});
