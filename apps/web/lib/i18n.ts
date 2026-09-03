import { headers } from 'next/headers';

import { resolveLocaleFromAcceptLanguage } from '@workspace/i18n-catalogs';
import {
  createWebTranslator,
  loadWebMessages,
  type I18nLocale,
  type WebTranslator,
} from '@workspace/i18n-catalogs/web';

/** Per-request locale: negotiated from Accept-Language, no locale URL segment. */
export async function resolveRequestLocale(): Promise<I18nLocale> {
  const headerList = await headers();
  return resolveLocaleFromAcceptLanguage(headerList.get('accept-language'));
}

export async function getRequestMessages(): Promise<{
  locale: I18nLocale;
  messages: Record<string, string>;
  t: WebTranslator;
}> {
  const locale = await resolveRequestLocale();
  const messages = await loadWebMessages(locale);
  return { locale, messages, t: createWebTranslator(messages) };
}
