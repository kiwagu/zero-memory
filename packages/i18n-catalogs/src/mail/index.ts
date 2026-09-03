import mailEn from '../catalogs/mail/mail.en.json' with { type: 'json' };
import type { MailLocale } from '../manifest';
import { MAIL_LOCALES } from '../manifest';
import { createTranslator, type Translator } from '../translator';

/**
 * Loader for the outgoing-mail catalog. Synchronous static imports, unlike the
 * dashboard's chunked loader: mail is rendered by the export script and by the
 * server, never in a browser bundle, so there is nothing to split.
 */
const CATALOGS: Record<MailLocale, Record<string, string>> = {
  en: mailEn as Record<string, string>,
};

export function isMailLocale(value: unknown): value is MailLocale {
  return (
    typeof value === 'string' &&
    (MAIL_LOCALES as readonly string[]).includes(value)
  );
}

export function loadMailMessages(locale: MailLocale): Record<string, string> {
  return CATALOGS[locale];
}

export function createMailTranslator(locale: MailLocale): Translator {
  return createTranslator(loadMailMessages(locale));
}

export { MAIL_LOCALES, createTranslator, type MailLocale, type Translator };
