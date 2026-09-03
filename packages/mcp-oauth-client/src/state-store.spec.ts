import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { OAuthStateStore } from './state-store.js';

const tempFile = (name = 'oauth.json'): string =>
  join(mkdtempSync(join(tmpdir(), 'zm-oauth-')), name);

describe('OAuthStateStore', () => {
  it('reads {} when the file is missing', () => {
    expect(new OAuthStateStore(tempFile('nope.json')).read()).toEqual({});
  });

  it('reads {} for a corrupt file instead of throwing', () => {
    const path = tempFile('bad.json');
    writeFileSync(path, 'not json');
    expect(new OAuthStateStore(path).read()).toEqual({});
  });

  it('round-trips an entry and merges successive updates', () => {
    const store = new OAuthStateStore(tempFile());
    const key = 'http://zm.local:8787/mcp';
    store.update(key, {
      redirectUri: 'http://127.0.0.1:1234/callback',
      codeVerifier: 'verifier-1',
    });
    store.update(key, {
      tokens: { access_token: 'a-token', token_type: 'Bearer' },
    });

    const entry = store.entry(key);
    expect(entry?.redirectUri).toBe('http://127.0.0.1:1234/callback');
    expect(entry?.codeVerifier).toBe('verifier-1');
    expect(entry?.tokens?.access_token).toBe('a-token');
  });

  it('keeps entries for different servers isolated', () => {
    const store = new OAuthStateStore(tempFile());
    store.update('http://a/mcp', { codeVerifier: 'a' });
    store.update('http://b/mcp', { codeVerifier: 'b' });
    expect(store.entry('http://a/mcp')?.codeVerifier).toBe('a');
    expect(store.entry('http://b/mcp')?.codeVerifier).toBe('b');
  });
});
