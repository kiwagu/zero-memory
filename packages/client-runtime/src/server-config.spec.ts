import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  configuredServerUrl,
  normalizeServerUrl,
  persistServerUrl,
  resolveServerUrl,
  resolveServerUrlOrNull,
  ServerNotConfiguredError,
  serverConfigPath,
  serverUrlOrigin,
} from './server-config.js';

describe('server-config', () => {
  let dir: string;
  let cfg: string;
  const prevConfig = process.env.ZM_CONFIG;
  const prevUrl = process.env.ZM_SERVER_URL;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'zm-server-config-'));
    cfg = join(dir, 'config.json');
    process.env.ZM_CONFIG = cfg;
    delete process.env.ZM_SERVER_URL;
  });

  afterEach(() => {
    const restore = (key: string, value: string | undefined): void => {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    };
    restore('ZM_CONFIG', prevConfig);
    restore('ZM_SERVER_URL', prevUrl);
    rmSync(dir, { recursive: true, force: true });
  });

  const writeCfg = (obj: unknown): void =>
    writeFileSync(cfg, JSON.stringify(obj));

  it('refuses to invent an address when nothing is configured', () => {
    expect(resolveServerUrlOrNull()).toBeNull();
    expect(serverUrlOrigin()).toBe('none');
    expect(() => resolveServerUrl()).toThrow(ServerNotConfiguredError);
  });

  it('names the fix in the failure — the whole point of having no default', () => {
    let message = '';
    try {
      resolveServerUrl();
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('zero-memory-watcher login');
    expect(message).toContain('ZM_SERVER_URL');
    expect(message).toContain(cfg);
  });

  it('reads the persisted config when no override is set', () => {
    writeCfg({ serverUrl: 'https://memory.example.com/mcp' });
    expect(configuredServerUrl()).toBe('https://memory.example.com/mcp');
    expect(resolveServerUrl()).toBe('https://memory.example.com/mcp');
    expect(serverUrlOrigin()).toBe('config');
  });

  it('lets the env var override the persisted config', () => {
    writeCfg({ serverUrl: 'https://memory.example.com/mcp' });
    process.env.ZM_SERVER_URL = 'http://localhost:8787/mcp';
    expect(resolveServerUrl()).toBe('http://localhost:8787/mcp');
    expect(serverUrlOrigin()).toBe('env');
  });

  it('treats a malformed, empty or non-http config as unset', () => {
    writeFileSync(cfg, 'not json at all');
    expect(configuredServerUrl()).toBeNull();
    writeCfg({ serverUrl: '' });
    expect(configuredServerUrl()).toBeNull();
    writeCfg({ serverUrl: 'file:///etc/passwd' });
    expect(configuredServerUrl()).toBeNull();
    writeCfg({});
    expect(configuredServerUrl()).toBeNull();
  });

  it('persists the address and preserves unrelated keys', () => {
    writeCfg({ serverUrl: 'http://old.example.test/mcp', other: 'keep me' });
    persistServerUrl('https://memory.example.com/mcp');
    const stored = JSON.parse(readFileSync(cfg, 'utf8')) as Record<
      string,
      unknown
    >;
    expect(stored.serverUrl).toBe('https://memory.example.com/mcp');
    expect(stored.other).toBe('keep me');
  });

  it('completes a bare host to the MCP endpoint when accepting one', () => {
    expect(normalizeServerUrl('https://memory.example.com')).toBe(
      'https://memory.example.com/mcp'
    );
    expect(normalizeServerUrl('https://memory.example.com/')).toBe(
      'https://memory.example.com/mcp'
    );
    // An explicit path is the caller's business — never rewritten.
    expect(normalizeServerUrl('https://memory.example.com/zm/mcp')).toBe(
      'https://memory.example.com/zm/mcp'
    );
    expect(persistServerUrl('https://memory.example.com')).toBe(
      'https://memory.example.com/mcp'
    );
  });

  it('points at the XDG config location by default', () => {
    const prevXdg = process.env.XDG_CONFIG_HOME;
    delete process.env.ZM_CONFIG;
    process.env.XDG_CONFIG_HOME = dir;
    try {
      expect(serverConfigPath()).toBe(join(dir, 'zero-memory', 'config.json'));
    } finally {
      if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = prevXdg;
    }
  });
});
