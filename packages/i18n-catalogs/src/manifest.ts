export const SUPPORTED_LOCALES = ['en', 'es'] as const;

export type I18nLocale = (typeof SUPPORTED_LOCALES)[number];

export const defaultLocale: I18nLocale = 'en';

/**
 * Locales the outgoing mail ships in. Deliberately a SUBSET of the product's
 * `SUPPORTED_LOCALES`: authentication mail is rendered to static HTML for
 * Supabase Auth, which picks one template per template type with no knowledge
 * of the recipient's language, so v1 sends English to everybody. The strings
 * still live in a catalog of the same shape as the dashboard's, so localising
 * mail later is adding `'es'` here plus `catalogs/mail/mail.es.json` — not
 * re-laying-out the emails.
 */
export const MAIL_LOCALES = ['en'] as const;

export type MailLocale = (typeof MAIL_LOCALES)[number];

export const CATALOG_MANIFEST = {
  web: {
    domains: ['web'] as const,
    supportedLocales: SUPPORTED_LOCALES,
  },
  mail: {
    domains: ['mail'] as const,
    supportedLocales: MAIL_LOCALES,
  },
} as const;

export type WebCatalogDomain = (typeof CATALOG_MANIFEST.web.domains)[number];

export type MailCatalogDomain = (typeof CATALOG_MANIFEST.mail.domains)[number];

const localeValues = [...SUPPORTED_LOCALES] as readonly string[];

export function isSupportedLocale(value: unknown): value is I18nLocale {
  return typeof value === 'string' && localeValues.includes(value);
}

export function assertValidLocale(value: unknown): asserts value is I18nLocale {
  if (!isSupportedLocale(value)) {
    throw new Error(
      `Invalid locale "${value}". Supported: ${SUPPORTED_LOCALES.join(', ')}`
    );
  }
}

export function resolveLocaleFromAcceptLanguage(
  acceptLanguage: string | null | undefined
): I18nLocale {
  if (!acceptLanguage) {
    return defaultLocale;
  }

  const candidates = acceptLanguage
    .toLowerCase()
    .split(',')
    .map((part) => part.split(';')[0]?.trim())
    .filter(Boolean);

  for (const candidate of candidates) {
    if (!candidate) {
      continue;
    }

    if (isSupportedLocale(candidate)) {
      return candidate;
    }

    const base = candidate.split('-')[0] ?? '';
    if (isSupportedLocale(base)) {
      return base;
    }
  }

  return defaultLocale;
}
