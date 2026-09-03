import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { hookManifest } from '@workspace/client-core';
import { describe, expect, it } from 'vitest';

import {
  duplicateEntries,
  missingEntries,
  parseHooksArgs,
  pluginsInstalled,
} from './hooks-runner.js';

describe('parseHooksArgs', () => {
  it('defaults to the profile of a machine with no plugin', () => {
    expect(parseHooksArgs([]).profile).toBe('full');
  });

  it('rejects an unknown profile instead of emitting an empty set', () => {
    // Silently printing nothing would make an installer wire nothing at all,
    // which is the failure this surface exists to catch.
    expect(parseHooksArgs(['--profile', 'nonsense']).profile).toBe('full');
  });

  it('reads the profile, binary and settings overrides', () => {
    const args = parseHooksArgs([
      '--profile',
      'ingest',
      '--bin',
      '/opt/zmw',
      '--settings',
      '/tmp/s.json',
    ]);
    expect(args).toMatchObject({
      profile: 'ingest',
      bin: '/opt/zmw',
      settings: '/tmp/s.json',
      check: false,
    });
  });
});

describe('missingEntries', () => {
  const full = hookManifest('full');

  it('reports everything missing when nothing is wired', () => {
    expect(missingEntries(full, {})).toHaveLength(full.length);
  });

  it('accepts a hook however its command spells the binary', () => {
    const entry = { event: 'Stop', command: 'ingest' };
    expect(
      missingEntries([entry], {
        Stop: ['~/.local/bin/zero-memory-watcher ingest'],
      })
    ).toEqual([]);
  });

  it('does not credit a wiring on the wrong event', () => {
    // The same runner is wired to several events; finding it under one must not
    // pass for another.
    expect(
      missingEntries([{ event: 'Stop', command: 'nudge' }], {
        PreToolUse: ['/bin/zero-memory-watcher nudge'],
      })
    ).toHaveLength(1);
  });

  it('credits each event separately for a runner wired to several', () => {
    const reminders = full.filter((entry) => entry.command === 'nudge');
    expect(reminders.length).toBeGreaterThan(1);
    // Only two of its events are wired — the rest must still be reported, which
    // a command-only check would have hidden.
    const missing = missingEntries(reminders, {
      PreToolUse: ['/bin/zero-memory-watcher nudge'],
      Stop: ['/bin/zero-memory-watcher nudge'],
    });
    expect(missing.map((entry) => entry.event).sort()).toEqual([
      'PostToolUse',
      'PostToolUseFailure',
    ]);
  });

  it('ignores foreign hooks that happen to sit on the same event', () => {
    expect(
      missingEntries([{ event: 'Stop', command: 'ingest' }], {
        Stop: ['jq -c "some other tool"', '/bin/zero-memory-watcher ingest'],
      })
    ).toEqual([]);
  });
});

describe('duplicateEntries', () => {
  const ingest = { event: 'Stop', command: 'ingest' };

  it('says nothing when each hook is wired once', () => {
    expect(
      duplicateEntries([ingest], { Stop: ['/bin/zero-memory-watcher ingest'] })
    ).toEqual([]);
  });

  it('reports a hook wired twice, however the copies spell the binary', () => {
    // The shape a plugin copy takes next to a settings copy — same subcommand,
    // different path, and both fire.
    expect(
      duplicateEntries([ingest], {
        Stop: [
          '/home/me/.local/bin/zero-memory-watcher ingest',
          '${CLAUDE_PLUGIN_ROOT}/bin/zero-memory-watcher ingest',
        ],
      })
    ).toEqual([{ entry: ingest, count: 2 }]);
  });

  it('does not count a foreign hook on the same event as a duplicate', () => {
    expect(
      duplicateEntries([ingest], {
        Stop: [
          'bun /home/me/.claude/hooks/something-else.ts',
          '/b/zero-memory-watcher ingest',
        ],
      })
    ).toEqual([]);
  });
});

describe('pluginsInstalled', () => {
  const registry = (body: string): string => {
    const path = join(mkdtempSync(join(tmpdir(), 'zm-plugins-')), 'reg.json');
    writeFileSync(path, body);
    return path;
  };

  it('is false for an empty registry', () => {
    expect(pluginsInstalled(registry('{"version":2,"plugins":{}}'))).toBe(
      false
    );
  });

  it('is true once a plugin is present', () => {
    expect(
      pluginsInstalled(registry('{"version":2,"plugins":{"zm@local":{}}}'))
    ).toBe(true);
  });

  it('is false when the registry is missing or unreadable', () => {
    // Guessing "installed" from an unreadable file would raise a warning nobody
    // could act on.
    expect(pluginsInstalled('/nonexistent/reg.json')).toBe(false);
    expect(pluginsInstalled(registry('not json'))).toBe(false);
  });
});
