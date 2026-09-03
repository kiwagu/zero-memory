import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { formatVersion, resolveVersion } from './version-runner.js';

const pluginRoot = (version: unknown): string => {
  const root = mkdtempSync(join(tmpdir(), 'zm-plugin-'));
  mkdirSync(join(root, '.claude-plugin'));
  writeFileSync(
    join(root, '.claude-plugin', 'plugin.json'),
    JSON.stringify({ name: 'zero-memory', version })
  );
  return root;
};

/** An isolated XDG_STATE_HOME keeps the real install's origin file out. */
const emptyState = (): NodeJS.ProcessEnv => ({
  XDG_STATE_HOME: mkdtempSync(join(tmpdir(), 'zm-state-')),
});

describe('resolveVersion', () => {
  it('reports the manifest of the plugin bundle running the binary', () => {
    const root = pluginRoot('1.2.3');
    expect(
      resolveVersion({ ...emptyState(), CLAUDE_PLUGIN_ROOT: root })
    ).toEqual({ version: '1.2.3', origin: 'plugin', source: root });
  });

  it('falls back to the compiled-in version when nothing is installed', () => {
    const result = resolveVersion(emptyState());
    expect(result.origin).toBe('build');
    expect(result.version).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('ignores a malformed plugin manifest instead of reporting garbage', () => {
    const result = resolveVersion({
      ...emptyState(),
      CLAUDE_PLUGIN_ROOT: pluginRoot(42),
    });
    expect(result.origin).toBe('build');
  });

  it('never throws on a missing CLAUDE_PLUGIN_ROOT directory', () => {
    const result = resolveVersion({
      ...emptyState(),
      CLAUDE_PLUGIN_ROOT: join(tmpdir(), 'zm-does-not-exist'),
    });
    expect(result.origin).toBe('build');
  });
});

describe('the deploy record never overrides the running version', () => {
  const stateWithOrigin = (installed: string): NodeJS.ProcessEnv => {
    const dir = mkdtempSync(join(tmpdir(), 'zm-state-'));
    mkdirSync(join(dir, 'zero-memory'));
    writeFileSync(
      join(dir, 'zero-memory', 'plugin-origin.json'),
      JSON.stringify({
        source: '/mnt/exchange/zm',
        source_manifest: '/mnt/exchange/zm/plugin.json',
        installed_version: installed,
        update_command: 'bash deploy-zm-client.sh',
      })
    );
    return { XDG_STATE_HOME: dir };
  };

  it('reports the compiled-in version, not the recorded one', () => {
    // The bug this replaces: a binary rebuilt without re-running a deploy
    // script kept reporting the number the old install had recorded — silently,
    // and in every server request that carries the client version.
    const result = resolveVersion(stateWithOrigin('0.1.0'));
    expect(result.origin).toBe('build');
    expect(result.version).not.toBe('0.1.0');
    expect(result.version).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('keeps the record as provenance and flags it as stale', () => {
    const result = resolveVersion(stateWithOrigin('0.1.0'));
    expect(result.source).toBe('/mnt/exchange/zm');
    expect(result.updateCommand).toBe('bash deploy-zm-client.sh');
    expect(result.recordedVersion).toBe('0.1.0');
  });

  it('does not flag a record that agrees with the binary', () => {
    const running = resolveVersion(emptyState()).version;
    expect(resolveVersion(stateWithOrigin(running)).recordedVersion).toBe(
      undefined
    );
  });
});

describe('formatVersion', () => {
  it('labels where the number came from and how to update it', () => {
    expect(
      formatVersion({
        version: '0.6.0',
        origin: 'build',
        source: '/mnt/exchange/zm',
        updateCommand: 'bash deploy-zm-client.sh',
      })
    ).toBe(
      'zero-memory-watcher 0.6.0 (build)\n' +
        '  source:  /mnt/exchange/zm\n' +
        '  update:  bash deploy-zm-client.sh'
    );
  });

  it('names a stale record instead of quietly dropping it', () => {
    // Fixing the number while leaving a contradicting file on disk would just
    // move the trap: the next person to read that file would trust it.
    expect(
      formatVersion({
        version: '0.14.0',
        origin: 'build',
        recordedVersion: '0.11.1',
      })
    ).toContain('claims 0.11.1 — stale');
  });

  it('withholds the update command of a stale record', () => {
    // An install can outlive the script that wrote its record, so offering that
    // command hands over something that cannot work.
    const out = formatVersion({
      version: '0.14.0',
      origin: 'build',
      source: '/repo',
      updateCommand: 'bash a-script-that-no-longer-exists.sh',
      recordedVersion: '0.11.1',
    });
    expect(out).not.toContain('a-script-that-no-longer-exists.sh');
    expect(out).toContain('update command is not shown');
    expect(out).toContain('source:  /repo');
  });

  it('prints a bare line when only the build version is known', () => {
    expect(formatVersion({ version: '0.1.0', origin: 'build' })).toBe(
      'zero-memory-watcher 0.1.0 (build)'
    );
  });
});
