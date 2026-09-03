import { loadWebMessages } from '@workspace/i18n-catalogs/web';
import { SUPPORTED_LOCALES } from '@workspace/i18n-catalogs';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { legalLinks } from './legal';

const cleanup = ['ZM_TERMS_URL', 'ZM_PRIVACY_URL', 'ZM_TERMS_VERSION'];
afterEach(() => {
  for (const key of cleanup) delete process.env[key];
  vi.restoreAllMocks();
});

describe('legalLinks', () => {
  it('asks for nothing when no document is configured', () => {
    expect(legalLinks()).toEqual({
      termsUrl: undefined,
      privacyUrl: undefined,
      version: undefined,
      documents: 'none',
      required: false,
    });
  });

  it('names both documents when both are published', () => {
    process.env.ZM_TERMS_URL = 'https://example.test/terms';
    process.env.ZM_PRIVACY_URL = 'https://example.test/privacy';
    expect(legalLinks()).toMatchObject({ documents: 'both', required: true });
  });

  it.each([
    ['ZM_TERMS_URL', 'terms'],
    ['ZM_PRIVACY_URL', 'privacy'],
  ])(
    'names only the document %s publishes, so the sentence cannot promise the other',
    (variable, documents) => {
      process.env[variable] = 'https://example.test/doc';
      expect(legalLinks()).toMatchObject({ documents, required: true });
    }
  );

  it('accepts a site-root path, for texts served next to the dashboard', () => {
    process.env.ZM_TERMS_URL = '/terms';
    process.env.ZM_PRIVACY_URL = '/privacy';
    expect(legalLinks()).toMatchObject({
      termsUrl: '/terms',
      privacyUrl: '/privacy',
      documents: 'both',
    });
  });

  it('carries the version label when one is set', () => {
    process.env.ZM_TERMS_URL = '/terms';
    process.env.ZM_TERMS_VERSION = ' 2026-09-03 ';
    expect(legalLinks().version).toBe('2026-09-03');
  });

  it.each(['terms', '//evil.test/terms', '../terms', 'javascript:alert(1)'])(
    'refuses %s and says so, rather than silently dropping the gate',
    (value) => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      process.env.ZM_TERMS_URL = value;
      expect(legalLinks()).toMatchObject({
        termsUrl: undefined,
        documents: 'none',
        required: false,
      });
      expect(warn).toHaveBeenCalledOnce();
    }
  );

  it('treats a rejected value as absent when choosing the sentence', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    process.env.ZM_TERMS_URL = 'not a url';
    process.env.ZM_PRIVACY_URL = '/privacy';
    // The reader can open the privacy policy and nothing else, so the sentence
    // must be the privacy-only one — not the pair.
    expect(legalLinks()).toMatchObject({ documents: 'privacy' });
  });
});

describe('the consent sentences', () => {
  // The page picks one of these three literal keys by configuration (a lint
  // rule forbids computing a key, so they live at the call site). A missing
  // key does not throw — the translator returns the key itself, and a stranger
  // would read "auth.consent.templateTerms" on the form. Only comparing the
  // two sides catches that.
  const SENTENCES = [
    { key: 'auth.consent.template', terms: true, privacy: true },
    { key: 'auth.consent.templateTerms', terms: true, privacy: false },
    { key: 'auth.consent.templatePrivacy', terms: false, privacy: true },
  ] as const;

  it.each(SUPPORTED_LOCALES)(
    'exist in the %s catalog and name only what they can link',
    async (locale) => {
      const messages = await loadWebMessages(locale);
      for (const { key, terms, privacy } of SENTENCES) {
        const template = messages[key];
        expect(template, `${key} missing from ${locale}`).toBeTruthy();
        // Naming a document the sentence cannot link is the defect the split
        // exists to prevent, so both directions are asserted.
        expect(template?.includes('{terms}'), `${key}/${locale} terms`).toBe(
          terms
        );
        expect(
          template?.includes('{privacy}'),
          `${key}/${locale} privacy`
        ).toBe(privacy);
      }
    }
  );
});
