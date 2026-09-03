import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { MAIL_LOCALES } from '@workspace/i18n-catalogs';
import { createMailTranslator } from '@workspace/i18n-catalogs/mail';
import { describe, expect, it } from 'vitest';

import { AUTH_TEMPLATES } from './auth-template.registry.js';
import { findMissingPlaceholders, gotrueVariable } from './gotrue.constants.js';
import { renderAuthTemplate, renderDigest } from './mail.render.js';

const repoRoot = resolve(fileURLToPath(new URL('../../..', import.meta.url)));
const exportDir = join(repoRoot, 'apps/web/public/email-templates');

/**
 * An unsubstituted catalog placeholder — `{email}` rather than GoTrue's
 * `{{ .Email }}`. It means a template asked for a variable the registry never
 * passed, which no reviewer would notice in a 6 KB HTML file.
 */
const UNRESOLVED_CATALOG_VAR = /(?<!\{)\{[a-z][a-zA-Z]*\}(?!\})/;

describe('authentication templates', () => {
  for (const locale of MAIL_LOCALES) {
    for (const spec of AUTH_TEMPLATES) {
      describe(`${spec.name} (${locale})`, () => {
        it('keeps every GoTrue placeholder it was handed', async () => {
          const { html } = await renderAuthTemplate(spec, locale);
          expect(findMissingPlaceholders(html, spec.placeholders)).toEqual([]);
        });

        it('leaves no catalog variable unsubstituted', async () => {
          const { html, text } = await renderAuthTemplate(spec, locale);
          expect(html).not.toMatch(UNRESOLVED_CATALOG_VAR);
          expect(text).not.toMatch(UNRESOLVED_CATALOG_VAR);
        });

        it('takes its subject from the catalog', async () => {
          const t = createMailTranslator(locale);
          const { subject } = await renderAuthTemplate(spec, locale);
          expect(subject).toBe(spec.subject(t));
          // The translator echoes an unknown key back, so a subject that still
          // looks like a key means the catalog entry is missing.
          expect(subject).not.toMatch(/^[a-z]+\.subject$/);
        });

        it('ships a plain-text alternative with the action link', async () => {
          const { text } = await renderAuthTemplate(spec, locale);
          expect(text.length).toBeGreaterThan(0);
          expect(text).toContain(gotrueVariable.confirmationUrl);
        });

        /**
         * The committed export IS this template's snapshot: it is the artifact
         * Auth actually serves, so asserting against it (instead of a second
         * copy in a `.snap` file) means a drifted export fails here too, not
         * only in the export gate.
         */
        it('matches the committed export', async () => {
          const { html } = await renderAuthTemplate(spec, locale);
          const committed = await readFile(
            join(exportDir, `${spec.name}.${locale}.html`),
            'utf8'
          );
          expect(html).toBe(committed);
        });
      });
    }
  }
});

describe('digest', () => {
  const period = { from: '12 Jan', to: '18 Jan' };
  const counts = {
    captured: 14,
    surfaced: 31,
    loopsOpened: 3,
    loopsClosed: 2,
  };

  it('renders the counts it was given', async () => {
    const { html, subject } = await renderDigest({
      locale: 'en',
      period,
      counts,
      dashboardUrl: 'https://memory.example.com',
    });

    expect(subject).toBe('Your week in zero-memory');
    for (const value of Object.values(counts)) {
      expect(html).toContain(String(value));
    }
    expect(html).toContain('12 Jan');
    expect(html).toContain('18 Jan');
    expect(html).toContain('https://memory.example.com');
    expect(html).not.toMatch(UNRESOLVED_CATALOG_VAR);
  });

  it('carries no GoTrue placeholders — it is product mail, not auth mail', async () => {
    const { html } = await renderDigest({
      locale: 'en',
      period,
      counts,
      dashboardUrl: 'https://memory.example.com',
    });
    expect(html).not.toContain('{{ .');
  });
});
