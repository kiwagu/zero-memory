/**
 * The dashboard must serve the exported authentication templates to an
 * ANONYMOUS client. This is not a nicety: on a self-hosted stack GoTrue fetches
 * the templates over HTTP with no session of any kind, so a route guard in front
 * of them means Auth gets a redirect, silently falls back to its own built-in
 * templates, and every user receives a mail we did not write.
 *
 * It is checked here rather than in the recovery spec because the CLI stack takes
 * its templates from `content_path` (served internally by the CLI), so nothing
 * else in the suite exercises this delivery path at all.
 */
import { expect, test } from '@playwright/test';

const TEMPLATES = [
  'confirmation.en.html',
  'recovery.en.html',
  'email_change.en.html',
  'invite.en.html',
];

test.describe('exported email templates', () => {
  for (const file of TEMPLATES) {
    test(`@smoke ${file} is served without a session, placeholders intact`, async ({
      request,
    }) => {
      // maxRedirects: 0 on purpose — following a redirect would land on /login
      // and return a cheerful 200 for the wrong document.
      const response = await request.get(`/email-templates/${file}`, {
        maxRedirects: 0,
      });
      expect(response.status()).toBe(200);

      const html = await response.text();
      expect(html).toContain('{{ .ConfirmationURL }}');
      expect(html).toContain('zero-memory');
    });
  }
});
