import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { FileOAuthProvider } from './file-oauth-provider.js';
import { OAuthStateStore } from './state-store.js';

const SERVER_URL = 'http://zm.local:8787/mcp';

const makeProvider = (options?: { redirectUri?: string }) => {
  const store = new OAuthStateStore(
    join(mkdtempSync(join(tmpdir(), 'zm-oauth-')), 'oauth.json')
  );
  const provider = new FileOAuthProvider({
    serverUrl: SERVER_URL,
    store,
    ...options,
  });
  return { provider, store };
};

const seedFullEntry = (store: OAuthStateStore) => {
  store.update(SERVER_URL, {
    redirectUri: 'http://127.0.0.1:1234/callback',
    clientInformation: {
      client_id: 'client-1',
      redirect_uris: ['http://127.0.0.1:1234/callback'],
    },
    tokens: {
      access_token: 'a-token',
      token_type: 'Bearer',
      refresh_token: 'r-token',
    },
    codeVerifier: 'verifier-1',
  });
};

describe('FileOAuthProvider.invalidateCredentials', () => {
  it("'tokens' drops only the token pair, keeping the registered client", () => {
    const { provider, store } = makeProvider();
    seedFullEntry(store);

    provider.invalidateCredentials('tokens');

    expect(provider.tokens()).toBeUndefined();
    expect(provider.clientInformation()?.client_id).toBe('client-1');
    expect(provider.redirectUrl).toBe('http://127.0.0.1:1234/callback');
  });

  it("'client' drops only the client registration", () => {
    const { provider, store } = makeProvider();
    seedFullEntry(store);

    provider.invalidateCredentials('client');

    expect(provider.clientInformation()).toBeUndefined();
    expect(provider.tokens()?.access_token).toBe('a-token');
  });

  it("'all' drops the whole entry", () => {
    const { provider, store } = makeProvider();
    seedFullEntry(store);

    provider.invalidateCredentials('all');

    expect(store.entry(SERVER_URL)).toBeUndefined();
  });
});

describe('FileOAuthProvider.clientMetadata', () => {
  it('refuses to build registration metadata without a redirect URI', () => {
    const { provider } = makeProvider();
    expect(() => provider.clientMetadata).toThrow(/Run the login command/);
  });

  it('uses the login-time redirect URI when present', () => {
    const { provider } = makeProvider({
      redirectUri: 'http://127.0.0.1:4321/callback',
    });
    expect(provider.clientMetadata.redirect_uris).toEqual([
      'http://127.0.0.1:4321/callback',
    ]);
  });
});
