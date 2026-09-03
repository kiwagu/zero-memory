import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  ingestAllowed,
  ingestMode,
  projectIgnored,
} from './project-consent.js';

describe('project-consent', () => {
  let dir: string;
  let cfg: string;
  let proj: string;
  const prev = process.env.ZM_INGEST_CONFIG;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'zm-consent-'));
    cfg = join(dir, 'ingest.json');
    proj = join(dir, 'project');
    mkdirSync(proj, { recursive: true });
    process.env.ZM_INGEST_CONFIG = cfg;
  });

  afterEach(() => {
    if (prev === undefined) {
      delete process.env.ZM_INGEST_CONFIG;
    } else {
      process.env.ZM_INGEST_CONFIG = prev;
    }
    rmSync(dir, { recursive: true, force: true });
  });

  const writeCfg = (obj: unknown): void =>
    writeFileSync(cfg, JSON.stringify(obj));

  it('defaults to off when there is no config', () => {
    expect(ingestMode()).toBe('off');
    expect(ingestAllowed(proj)).toEqual({ allowed: false, reason: 'mode-off' });
  });

  it('allowlist ["*"] captures every project', () => {
    writeCfg({ allowlist: ['*'] });
    expect(ingestAllowed(proj)).toEqual({
      allowed: true,
      reason: 'allowlisted',
    });
  });

  it('denylist ["*"] captures nothing (equivalent to off)', () => {
    writeCfg({ denylist: ['*'] });
    expect(ingestAllowed(proj).allowed).toBe(false);
  });

  it('denylist default-allows a project no pattern matches', () => {
    writeCfg({ denylist: ['*/secret/*'] });
    expect(ingestAllowed(proj)).toEqual({ allowed: true, reason: 'denylist' });
  });

  it('allowlist matches by path glob and denies non-matches', () => {
    writeCfg({ allowlist: [join(dir, '*')] });
    expect(ingestAllowed(proj).allowed).toBe(true);
    expect(ingestAllowed('/somewhere/else').allowed).toBe(false);
  });

  it('.zero-memory-ignore always excludes, even under allowlist ["*"]', () => {
    writeCfg({ allowlist: ['*'] });
    writeFileSync(join(proj, '.zero-memory-ignore'), '');
    expect(projectIgnored(proj)).toBe(true);
    expect(ingestAllowed(proj)).toEqual({
      allowed: false,
      reason: 'project-ignored',
    });
  });

  it('.zero-memory-allow opts a project into allowlist mode', () => {
    writeCfg({ allowlist: ['no-such-name'] });
    writeFileSync(join(proj, '.zero-memory-allow'), '');
    expect(ingestAllowed(proj).allowed).toBe(true);
  });

  it('treats a config with both/neither list as off', () => {
    writeCfg({ allowlist: ['*'], denylist: ['*'] });
    expect(ingestMode()).toBe('off');
  });
});
