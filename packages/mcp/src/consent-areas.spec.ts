import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { CONSENT_AREAS } from './consent-areas.js';
import { TOOL_ANNOTATIONS } from './mcp-server.js';

/**
 * The consent screen tells a person what an agent may do once allowed. It is
 * only honest if it covers the whole tool list, so this checks the chain from
 * the tools to the words on the page, reading the catalogs and the page the
 * same way the ownership-map spec reads the generated schema.
 */
const repoFile = (path: string): string =>
  readFileSync(
    fileURLToPath(new URL(`../../../${path}`, import.meta.url)),
    'utf8'
  );

const areaIds = Object.keys(CONSENT_AREAS);

describe('consent areas', () => {
  it('place every registered tool in exactly one area', () => {
    const placed = Object.values(CONSENT_AREAS).flat();
    expect([...placed].sort()).toEqual(Object.keys(TOOL_ANNOTATIONS).sort());
    expect(new Set(placed).size).toBe(placed.length);
  });

  it.each(['en', 'es'])('have a title and a description in %s', (locale) => {
    const catalog = JSON.parse(
      repoFile(`packages/i18n-catalogs/src/catalogs/web/web.${locale}.json`)
    ) as Record<string, string>;
    for (const id of areaIds) {
      expect(catalog[`oauth.consent.areas.${id}.title`], id).toBeTruthy();
      expect(catalog[`oauth.consent.areas.${id}.body`], id).toBeTruthy();
    }
  });

  it('each have a line on the consent page', () => {
    // The dashboard's lint requires literal catalog keys, so every area the
    // page renders appears in its source by name.
    const page = repoFile('apps/web/app/oauth/consent/page.tsx');
    for (const id of areaIds) {
      expect(page, id).toContain(`'oauth.consent.areas.${id}.title'`);
      expect(page, id).toContain(`'oauth.consent.areas.${id}.body'`);
    }
  });
});
