import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  checkForUpdate,
  compareVersions,
  parseOrigin,
} from './update-check.js';

describe('compareVersions', () => {
  it('orders x.y.z versions numerically', () => {
    expect(compareVersions('0.3.0', '0.2.0')).toBe(1);
    expect(compareVersions('0.2.0', '0.3.0')).toBe(-1);
    expect(compareVersions('0.2.0', '0.2.0')).toBe(0);
    expect(compareVersions('0.10.0', '0.9.9')).toBe(1);
    expect(compareVersions('1.0.0', '0.99.99')).toBe(1);
  });

  it('returns null (never notify) on unparseable input', () => {
    expect(compareVersions('0.2', '0.2.0')).toBeNull();
    expect(compareVersions('abc', '0.2.0')).toBeNull();
    expect(compareVersions('0.2.0', '')).toBeNull();
    expect(compareVersions('0.2.0-rc1', '0.2.0')).toBeNull();
  });
});

describe('parseOrigin', () => {
  const valid = {
    source: '/mnt/share/zm-bundle',
    source_manifest:
      '/mnt/share/zm-bundle/plugins/zero-memory-claude/.claude-plugin/plugin.json',
    installed_version: '0.2.0',
    update_command: 'bash /mnt/share/zm-bundle/deploy-zm-claude-remote-host.sh',
  };

  it('accepts a complete origin record', () => {
    expect(parseOrigin(JSON.stringify(valid))).toEqual(valid);
  });

  it('rejects malformed JSON and missing fields', () => {
    expect(parseOrigin('not json')).toBeNull();
    expect(parseOrigin('{}')).toBeNull();
    const { update_command: _dropped, ...partial } = valid;
    expect(parseOrigin(JSON.stringify(partial))).toBeNull();
  });
});

describe('checkForUpdate compares against the RUNNING version', () => {
  /** A state dir with an origin record whose source manifest really exists. */
  const install = (recorded: string, ships: string): string => {
    const dir = mkdtempSync(join(tmpdir(), 'zm-upd-'));
    mkdirSync(join(dir, 'zero-memory'));
    const manifest = join(dir, 'plugin.json');
    writeFileSync(manifest, JSON.stringify({ version: ships }));
    writeFileSync(
      join(dir, 'zero-memory', 'plugin-origin.json'),
      JSON.stringify({
        source: dir,
        source_manifest: manifest,
        installed_version: recorded,
        update_command: 'bash deploy.sh',
      })
    );
    return dir;
  };

  const withState = async <T>(
    dir: string,
    run: () => Promise<T>
  ): Promise<T> => {
    const previous = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = dir;
    try {
      return await run();
    } finally {
      if (previous === undefined) delete process.env.XDG_STATE_HOME;
      else process.env.XDG_STATE_HOME = previous;
    }
  };

  it('stays silent when the running version already matches the source', () =>
    // THE BUG this guards: the record still said 0.11.1 while the binary was
    // 0.14.0, so an upgrade that was already installed kept being announced.
    withState(install('0.11.1', '0.14.0'), async () => {
      expect(await checkForUpdate('0.14.0')).toBeNull();
    }));

  it('announces an update the running version really is behind', () =>
    withState(install('0.14.0', '0.15.0'), async () => {
      expect(await checkForUpdate('0.14.0')).toEqual({
        installed: '0.14.0',
        latest: '0.15.0',
        command: 'bash deploy.sh',
      });
    }));

  it('reports the running version in the notice, not the recorded one', () =>
    withState(install('0.1.0', '0.15.0'), async () => {
      expect((await checkForUpdate('0.14.0'))?.installed).toBe('0.14.0');
    }));

  it('stays silent when the source manifest cannot be read', () =>
    withState(install('0.14.0', '0.15.0'), async () => {
      rmSync(join(process.env.XDG_STATE_HOME!, 'plugin.json'));
      expect(await checkForUpdate('0.14.0')).toBeNull();
    }));

  it('stays silent when nothing was ever recorded', () =>
    withState(mkdtempSync(join(tmpdir(), 'zm-bare-')), async () => {
      expect(await checkForUpdate('0.14.0')).toBeNull();
    }));
});
