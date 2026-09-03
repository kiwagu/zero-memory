import { describe, expect, it } from 'vitest';

import {
  clientBundle,
  hostedDashboardUrl,
  hostedMcpUrl,
} from './client-bundle.js';

describe('clientBundle', () => {
  it('offers no download when the build published none', () => {
    const bundle = clientBundle({});
    expect(bundle.url).toBeNull();
    expect(bundle.version).toBeNull();
  });

  it('takes a path this site serves itself, before the archive has a home', () => {
    const bundle = clientBundle({
      ZM_CLIENT_BUNDLE_URL: '/files/zm-bundle-0.18.1-linux-x86_64.zip',
    });
    expect(bundle.url).toBe('/files/zm-bundle-0.18.1-linux-x86_64.zip');
    expect(bundle.fileName).toBe('zm-bundle-0.18.1-linux-x86_64.zip');
    expect(bundle.dirName).toBe('zm-bundle-0.18.1-linux-x86_64');
    // Nothing can curl a path — the page must offer the button instead.
    expect(bundle.servedBySite).toBe(true);
  });

  it('refuses relative shapes that break once the page moves', () => {
    // Depth-dependent: resolves against whatever page renders it.
    expect(
      clientBundle({ ZM_CLIENT_BUNDLE_URL: 'files/x.zip' }).url
    ).toBeNull();
    // An absolute URL wearing a relative coat — it names another host.
    expect(
      clientBundle({ ZM_CLIENT_BUNDLE_URL: '//example.com/x.zip' }).url
    ).toBeNull();
    expect(
      clientBundle({ ZM_CLIENT_BUNDLE_URL: '/files/../../etc/passwd' }).url
    ).toBeNull();
  });

  it('never invents an address from a malformed value', () => {
    expect(clientBundle({ ZM_CLIENT_BUNDLE_URL: 'not a url' }).url).toBeNull();
    expect(clientBundle({ ZM_CLIENT_BUNDLE_URL: '   ' }).url).toBeNull();
    // A local path would render a link that only works on the build machine.
    expect(
      clientBundle({ ZM_CLIENT_BUNDLE_URL: 'file:///tmp/zm-bundle.zip' }).url
    ).toBeNull();
  });

  it('takes the archive the build points at, wherever it is hosted', () => {
    const bundle = clientBundle({
      ZM_CLIENT_BUNDLE_URL:
        'https://downloads.example.com/zm/zm-bundle-0.18.1.zip',
      ZM_CLIENT_BUNDLE_VERSION: '0.18.1',
    });
    expect(bundle.url).toBe(
      'https://downloads.example.com/zm/zm-bundle-0.18.1.zip'
    );
    expect(bundle.fileName).toBe('zm-bundle-0.18.1.zip');
    expect(bundle.dirName).toBe('zm-bundle-0.18.1');
    expect(bundle.version).toBe('0.18.1');
  });

  it('names the per-platform archive and the folder it unpacks into', () => {
    // The shape a release page needs: builds for other platforms sit beside
    // this one, and the file says which machine it is for.
    const bundle = clientBundle({
      ZM_CLIENT_BUNDLE_URL:
        'https://downloads.example.com/zm/zm-bundle-0.18.1-linux-x86_64.zip',
    });
    expect(bundle.fileName).toBe('zm-bundle-0.18.1-linux-x86_64.zip');
    expect(bundle.dirName).toBe('zm-bundle-0.18.1-linux-x86_64');
    expect(bundle.servedBySite).toBe(false);
  });

  it('falls back to a sane file name when the URL carries none', () => {
    expect(
      clientBundle({
        ZM_CLIENT_BUNDLE_URL: 'https://example.com/download?id=7',
      }).fileName
    ).toBe('zm-bundle.zip');
  });
});

describe('hosted instance addresses', () => {
  it('defaults to the published instance', () => {
    expect(hostedMcpUrl({})).toBe('https://api.zero-memory.com/mcp');
    expect(hostedDashboardUrl({})).toBe('https://app.zero-memory.com');
  });

  it('keeps service addresses absolute — a path cannot name a host', () => {
    expect(hostedMcpUrl({ ZM_HOSTED_MCP_URL: '/mcp' })).toBe(
      'https://api.zero-memory.com/mcp'
    );
    expect(hostedDashboardUrl({ ZM_HOSTED_WEB_URL: '/app' })).toBe(
      'https://app.zero-memory.com'
    );
  });

  it('lets a build document a different deployment', () => {
    expect(hostedMcpUrl({ ZM_HOSTED_MCP_URL: 'https://zm.acme.dev/mcp' })).toBe(
      'https://zm.acme.dev/mcp'
    );
    expect(
      hostedDashboardUrl({ ZM_HOSTED_WEB_URL: 'https://memory.acme.dev' })
    ).toBe('https://memory.acme.dev');
  });
});
