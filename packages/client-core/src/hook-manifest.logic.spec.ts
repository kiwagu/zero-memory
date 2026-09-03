import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  hookCommand,
  hookIdentity,
  hookManifest,
  WATCHER_BIN_NAME,
  type HookEntry,
} from './hook-manifest.logic.js';

describe('hookManifest', () => {
  it('gives a plugin-equipped machine exactly the capture hooks in its settings file', () => {
    // Capture stays in the user's own settings file even when a plugin is
    // installed, so it remains visible and removable there. The compaction
    // boundary captures too, so it is held to the same rule.
    expect(hookManifest('ingest')).toEqual([
      { event: 'Stop', command: 'ingest' },
      { event: 'PreCompact', command: 'checkpoint', timeout: 10 },
    ]);
  });

  it.each(['ingest', 'checkpoint'])(
    'omits the %s capture hook from the plugin channel',
    (command) => {
      expect(
        hookManifest('plugin').some((entry) => entry.command === command)
      ).toBe(false);
    }
  );

  it('omits the injected mandate from the no-plugin channel', () => {
    // That channel installs the mandate as an always-on rule in the agent's
    // global instruction file, which the plugin channel cannot do — wiring the
    // hook as well would deliver the same text twice.
    expect(
      hookManifest('full').some((entry) => entry.command === 'guide')
    ).toBe(false);
    expect(
      hookManifest('plugin').some((entry) => entry.command === 'guide')
    ).toBe(true);
  });

  it.each(['ingest', 'checkpoint'])(
    'carries the %s capture hook in the no-plugin channel',
    (command) => {
      expect(
        hookManifest('full').some((entry) => entry.command === command)
      ).toBe(true);
    }
  );

  it('works the compaction boundary from the event that precedes it', () => {
    // Wiring this after the boundary would be worthless twice over: the epoch
    // to capture is already condensed, and the summary it should have shaped is
    // already written.
    const checkpoint = hookManifest('full').find(
      (entry) => entry.command === 'checkpoint'
    );
    expect(checkpoint?.event).toBe('PreCompact');
    expect(checkpoint?.timeout).toBe(10);
  });

  it.each(['plugin', 'full'] as const)(
    'wires the reminder with its counter in the %s channel',
    (profile) => {
      // The reminder is one concern behind one per-session counter, so its
      // wirings must arrive TOGETHER. Ship a reminder without the PostToolUse
      // counter and its gate reads zero reads forever — so it fires on every
      // session unconditionally, which is the noise the gate exists to avoid.
      // This once held for one channel and not the other.
      const events = hookManifest(profile)
        .filter((entry) => entry.command === 'nudge')
        .map((entry) => entry.event)
        .sort();
      expect(events).toEqual([
        'PostToolUse',
        'PostToolUseFailure',
        'PreToolUse',
        'Stop',
      ]);
    }
  );

  it('counts memory-tool calls under the mounted tool-name prefix', () => {
    const tracker = hookManifest('full').find(
      (e) => e.event === 'PostToolUse' && e.command === 'nudge'
    );
    expect(tracker?.matcher).toBe('mcp__zero-memory__.*');
  });

  it.each(['plugin', 'ingest', 'full'] as const)(
    'keeps every (event, command) pair unique in the %s profile',
    (profile) => {
      // Both the idempotent upsert into a settings file and the wiring check
      // identify a hook by its event plus its command substring — a command is
      // reused across events on purpose. Two entries sharing BOTH would be
      // indistinguishable, so one would silently mask the other.
      const pairs = hookManifest(profile).map(
        (entry) => `${entry.event}|${entry.command}`
      );
      expect(new Set(pairs).size).toBe(pairs.length);
    }
  );

  it('allows the receipt more than the default hook timeout', () => {
    const receipt = hookManifest('full').find((e) => e.command === 'receipt');
    expect(receipt?.timeout).toBe(10);
  });
});

describe('hookIdentity', () => {
  it('matches the same hook however its command spells the binary', () => {
    const entry: HookEntry = { event: 'Stop', command: 'ingest' };
    const identity = hookIdentity(entry);
    for (const spelling of [
      'zero-memory-watcher ingest',
      '~/.local/bin/zero-memory-watcher ingest',
      '/home/someone/.local/bin/zero-memory-watcher ingest',
    ]) {
      expect(spelling.includes(identity)).toBe(true);
    }
  });

  it('does not confuse two subcommands that share a prefix', () => {
    // `brief session-start` must not be recognized by `brief task`'s identity.
    const sessionStart = hookIdentity({
      event: 'SessionStart',
      command: 'brief session-start',
    });
    expect(`/bin/${WATCHER_BIN_NAME} brief task`.includes(sessionStart)).toBe(
      false
    );
  });
});

describe('hookCommand', () => {
  it('spells the binary as the absolute path it was given', () => {
    expect(
      hookCommand({ event: 'Stop', command: 'ingest' }, '/opt/bin/zmw')
    ).toBe('/opt/bin/zmw ingest');
  });
});

/**
 * Drift guard — the reason this module exists.
 *
 * The plugin's committed hook manifest is a separate file that a person edits by
 * hand, so nothing but a test stops it from gaining a hook this declaration
 * never hears about. That is exactly how the two channels diverged before, and
 * the symptom was silence rather than a failure. The comparison ignores how each
 * side spells the binary path and compares the wiring itself.
 */
describe('the plugin channel matches its committed manifest', () => {
  const repoRoot = join(import.meta.dirname, '..', '..', '..');
  const hooksJsonPath = join(
    repoRoot,
    'plugins',
    'zero-memory-claude',
    'hooks',
    'hooks.json'
  );

  interface RawHook {
    command?: string;
    timeout?: number;
  }
  interface RawGroup {
    matcher?: string;
    hooks?: RawHook[];
  }

  const wiringOf = (entries: readonly HookEntry[]): string[] =>
    entries
      .map((e) =>
        [e.event, e.matcher ?? '', e.command, e.timeout ?? ''].join('|')
      )
      .sort();

  it('declares the same events, matchers, commands and timeouts', () => {
    const raw = JSON.parse(readFileSync(hooksJsonPath, 'utf8')) as {
      hooks: Record<string, RawGroup[]>;
    };
    const committed: HookEntry[] = [];
    for (const [event, groups] of Object.entries(raw.hooks)) {
      for (const group of groups) {
        for (const hook of group.hooks ?? []) {
          const command = hook.command ?? '';
          const marker = `${WATCHER_BIN_NAME} `;
          const at = command.indexOf(marker);
          // A hook that does not call our binary is not ours to declare.
          if (at < 0) continue;
          committed.push({
            event,
            ...(group.matcher ? { matcher: group.matcher } : {}),
            command: command.slice(at + marker.length),
            ...(hook.timeout === undefined ? {} : { timeout: hook.timeout }),
          });
        }
      }
    }
    expect(wiringOf(committed)).toEqual(wiringOf(hookManifest('plugin')));
  });
});

/**
 * The same drift guard, for the two channels this declaration does NOT own.
 *
 * Cursor and Codex speak their own hook dialects — different event names, and
 * in Cursor's case a different file shape — so their manifests are written by
 * hand rather than rendered from the profiles above. That is precisely the
 * arrangement whose failure mode is silence: a capability lands on one client
 * and is simply absent on the others, with nothing failing anywhere. These
 * assertions name what each committed manifest must carry, so adding a hook to
 * one client and forgetting the rest breaks a test instead of going unnoticed.
 *
 * The compaction boundary is asserted for both because BOTH can capture there;
 * only Claude Code can also deliver into the summary, and that asymmetry lives
 * in the adapters rather than here.
 */
describe('the sibling clients carry the same boundary hooks', () => {
  const repoRoot = join(import.meta.dirname, '..', '..', '..');
  const manifestOf = (plugin: string): string =>
    readFileSync(
      join(repoRoot, 'plugins', plugin, 'hooks', 'hooks.json'),
      'utf8'
    );

  it.each([
    ['zero-memory-codex', 'PreCompact', 'checkpoint --client codex'],
    ['zero-memory-cursor', 'preCompact', 'checkpoint --client cursor'],
  ])('wires %s to work the compaction boundary', (plugin, event, command) => {
    const raw = manifestOf(plugin);
    const parsed = JSON.parse(raw) as { hooks: Record<string, unknown> };
    expect(
      Object.keys(parsed.hooks),
      'the client announces its compaction event under its own spelling'
    ).toContain(event);
    expect(raw).toContain(`${WATCHER_BIN_NAME} ${command}`);
  });

  it('wires Codex PostCompact to re-arm delivery after capture', () => {
    const raw = manifestOf('zero-memory-codex');
    const parsed = JSON.parse(raw) as { hooks: Record<string, unknown> };
    expect(Object.keys(parsed.hooks)).toContain('PostCompact');
    expect(raw).toContain(`${WATCHER_BIN_NAME} checkpoint post --client codex`);
  });

  it.each([
    ['zero-memory-codex', 'ingest --client codex'],
    ['zero-memory-cursor', 'ingest --client cursor'],
  ])('keeps end-of-turn capture wired in %s', (plugin, command) => {
    // Capture at the boundary supplements the end-of-turn flush; it never
    // replaces it. Losing this one while adding the other would trade a
    // per-turn capture for a per-compaction one and read as an upgrade.
    expect(manifestOf(plugin)).toContain(`${WATCHER_BIN_NAME} ${command}`);
  });
});
