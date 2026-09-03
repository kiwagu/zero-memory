/**
 * Catalog completeness gate (runs in lint): every domain must ship the same
 * key set in every supported locale. Exits non-zero listing the missing keys,
 * so a partially-translated catalog cannot land.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

import { CATALOG_MANIFEST } from './manifest';

const here = dirname(fileURLToPath(import.meta.url));

let failed = false;

for (const [app, { domains, supportedLocales }] of Object.entries(
  CATALOG_MANIFEST
)) {
  for (const domain of domains) {
    const keysByLocale = new Map<string, Set<string>>();

    for (const locale of supportedLocales) {
      const path = join(here, 'catalogs', app, `${domain}.${locale}.json`);
      let parsed: unknown;
      try {
        parsed = JSON.parse(readFileSync(path, 'utf8'));
      } catch (error) {
        console.error(`[i18n] ${app}/${domain}.${locale}.json: ${error}`);
        failed = true;
        continue;
      }
      if (
        typeof parsed !== 'object' ||
        parsed === null ||
        Array.isArray(parsed) ||
        Object.values(parsed).some((value) => typeof value !== 'string')
      ) {
        console.error(
          `[i18n] ${app}/${domain}.${locale}.json: must be a flat string map`
        );
        failed = true;
        continue;
      }
      keysByLocale.set(locale, new Set(Object.keys(parsed)));
    }

    const allKeys = new Set<string>();
    for (const keys of keysByLocale.values()) {
      for (const key of keys) {
        allKeys.add(key);
      }
    }

    for (const [locale, keys] of keysByLocale) {
      const missing = [...allKeys].filter((key) => !keys.has(key)).sort();
      if (missing.length > 0) {
        console.error(
          `[i18n] ${app}/${domain}.${locale}.json is missing ${missing.length} key(s):\n  ${missing.join('\n  ')}`
        );
        failed = true;
      }
    }
  }
}

if (failed) {
  process.exit(1);
}
console.log('[i18n] catalogs are complete');
