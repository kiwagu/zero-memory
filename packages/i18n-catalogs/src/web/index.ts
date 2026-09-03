import type { I18nLocale } from '../manifest';
import { assertValidLocale } from '../manifest';

/**
 * Loader for the web dashboard catalog: a static switch over dynamic imports
 * so the bundler can resolve each locale chunk, plus an in-memory cache per
 * locale.
 */

const CATALOGS: Record<I18nLocale, Record<string, string> | undefined> = {
  en: undefined,
  es: undefined,
};

async function importWebCatalog(
  locale: I18nLocale
): Promise<Record<string, string>> {
  assertValidLocale(locale);

  // Static switch required for bundler module resolution.
  switch (locale) {
    case 'es':
      return (
        await import('../catalogs/web/web.es.json', {
          with: { type: 'json' },
        })
      ).default as Record<string, string>;
    case 'en':
    default:
      return (
        await import('../catalogs/web/web.en.json', {
          with: { type: 'json' },
        })
      ).default as Record<string, string>;
  }
}

export async function loadWebMessages(
  locale: I18nLocale
): Promise<Record<string, string>> {
  if (CATALOGS[locale]) {
    return CATALOGS[locale];
  }

  const catalog = await importWebCatalog(locale);
  CATALOGS[locale] = catalog;
  return catalog;
}

/**
 * The dashboard's translator is the shared flat-catalog one; the web-prefixed
 * names stay as the dashboard's public surface.
 */
export {
  createTranslator as createWebTranslator,
  type Translator as WebTranslator,
} from '../translator';

export type { I18nLocale };
