import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import {
  hookCommand,
  hookIdentity,
  hookManifest,
  type HookEntry,
  type HookProfile,
} from '@workspace/client-core';
import { createLogger } from '@workspace/logger';

const logger = createLogger('hooks');

/** Where the installed binary lives, and so what a wired hook should call. */
const defaultBin = (): string =>
  join(homedir(), '.local', 'bin', 'zero-memory-watcher');

/**
 * The agent settings file the wiring check inspects.
 *
 * Claude Code's shape, because that is the client whose hooks live in a settings
 * file at all: Cursor keeps its own `hooks.json` and Codex a TOML section, so
 * pointing this at one of those would report nonsense rather than degrade. Pass
 * `--settings` to inspect a different file.
 */
const defaultSettings = (): string =>
  join(homedir(), '.claude', 'settings.json');

/**
 * The agent's plugin registry — read only to notice that a plugin is installed
 * alongside the complete settings profile, which would double every hook.
 */
const defaultPluginRegistry = (): string =>
  join(homedir(), '.claude', 'plugins', 'installed_plugins.json');

export interface HooksArgs {
  profile: HookProfile;
  bin: string;
  settings: string;
  plugins: string;
  check: boolean;
}

const PROFILES = new Set<HookProfile>(['plugin', 'ingest', 'full']);

const flagValue = (args: string[], flag: string): string | undefined => {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
};

export const parseHooksArgs = (args: string[]): HooksArgs => {
  const raw = flagValue(args, '--profile');
  return {
    profile:
      raw && PROFILES.has(raw as HookProfile) ? (raw as HookProfile) : 'full',
    bin: flagValue(args, '--bin') ?? defaultBin(),
    settings: flagValue(args, '--settings') ?? defaultSettings(),
    plugins: flagValue(args, '--plugins') ?? defaultPluginRegistry(),
    check: args.includes('--check'),
  };
};

interface RawHook {
  command?: unknown;
}
interface RawGroup {
  hooks?: RawHook[];
}

/**
 * The hook commands present in the settings file, KEYED BY EVENT.
 *
 * Grouping by event is not incidental. One subcommand is wired to several
 * different events (the recall reminder is four wirings of one runner), so its
 * command substring alone cannot tell them apart — a check that flattened every
 * event into one list would see a single wiring and report all four as present,
 * which is precisely the false all-clear this whole surface exists to prevent.
 *
 * Deliberately tolerant: an unreadable or hand-mangled settings file yields an
 * empty map rather than an error, because this runs inside a check whose whole
 * job is to report a problem — throwing would replace the report with a crash.
 */
export const wiredCommandsByEvent = (
  settingsPath: string
): Record<string, string[]> => {
  let parsed: { hooks?: Record<string, RawGroup[]> };
  try {
    parsed = JSON.parse(readFileSync(settingsPath, 'utf8')) as {
      hooks?: Record<string, RawGroup[]>;
    };
  } catch {
    return {};
  }
  const found: Record<string, string[]> = {};
  for (const [event, groups] of Object.entries(parsed.hooks ?? {})) {
    for (const group of groups ?? []) {
      for (const hook of group.hooks ?? []) {
        if (typeof hook.command === 'string') {
          (found[event] ??= []).push(hook.command);
        }
      }
    }
  }
  return found;
};

/** The manifest entries whose event carries no command satisfying them. */
export const missingEntries = (
  entries: readonly HookEntry[],
  byEvent: Readonly<Record<string, readonly string[]>>
): HookEntry[] =>
  entries.filter(
    (entry) =>
      !(byEvent[entry.event] ?? []).some((command) =>
        command.includes(hookIdentity(entry))
      )
  );

/**
 * Entries wired MORE THAN ONCE on their event — every one of them fires.
 *
 * The applier cannot create this, but two things do: a hand edit, and a settings
 * file that also carries a copy pointing into a plugin's own directory. The
 * consequence is not a crash, it is the same reminder or briefing arriving twice,
 * which reads as the tool being broken rather than misconfigured. Reported for the
 * same reason a missing hook is: the state must be visible instead of inferred.
 */
export const duplicateEntries = (
  entries: readonly HookEntry[],
  byEvent: Readonly<Record<string, readonly string[]>>
): { entry: HookEntry; count: number }[] =>
  entries
    .map((entry) => ({
      entry,
      count: (byEvent[entry.event] ?? []).filter((command) =>
        command.includes(hookIdentity(entry))
      ).length,
    }))
    .filter(({ count }) => count > 1);

/**
 * Whether any plugin is installed for the agent.
 *
 * Read to answer one question the wiring alone cannot: the complete settings
 * profile assumes it is the machine's ONLY channel, so a plugin present at the
 * same time means both channels fire and everything doubles. Tolerant by design —
 * an absent or unfamiliar registry yields `false`, because guessing "a plugin is
 * installed" from an unreadable file would raise a warning nobody can act on.
 */
export const pluginsInstalled = (registryPath: string): boolean => {
  try {
    const parsed = JSON.parse(readFileSync(registryPath, 'utf8')) as {
      plugins?: Record<string, unknown>;
    };
    return Object.keys(parsed.plugins ?? {}).length > 0;
  } catch {
    return false;
  }
};

/** How an entry reads in the report. */
const label = (entry: HookEntry): string =>
  `${entry.event}${entry.matcher ? `[${entry.matcher}]` : ''}`;

/**
 * `hooks --check` — report what is actually wired, in both directions.
 *
 * The failure this exists for is not a crash but SILENCE: a hook feature can be
 * built, merged and serving on a machine whose settings file never gained its
 * entry, and every other signal looks healthy. So the report names each missing
 * hook and exits non-zero, making the gap something a person or a script can see
 * instead of something only weeks of absent output would reveal.
 *
 * It reports the OPPOSITE misconfiguration too, because that one also reads as a
 * broken tool rather than a wiring mistake: the same hook wired twice, and a
 * plugin installed alongside the complete profile — which assumes it is the only
 * channel, so both would fire and every briefing and reminder would arrive twice.
 */
const runCheck = (args: HooksArgs): void => {
  const entries = hookManifest(args.profile);
  const byEvent = wiredCommandsByEvent(args.settings);
  const missing = missingEntries(entries, byEvent);
  const duplicated = duplicateEntries(entries, byEvent);
  const wired = entries.length - missing.length;
  process.stdout.write(
    `zero-memory hooks: ${wired}/${entries.length} wired in ${args.settings} ` +
      `(profile ${args.profile})\n`
  );
  for (const entry of missing) {
    process.stdout.write(
      `  MISSING    ${label(entry)} -> ${hookCommand(entry, args.bin)}\n`
    );
  }
  for (const { entry, count } of duplicated) {
    process.stdout.write(
      `  DUPLICATE  ${label(entry)} -> ${entry.command} wired ${count}× ` +
        `(every copy fires)\n`
    );
  }
  const bothChannels =
    args.profile === 'full' && pluginsInstalled(args.plugins);
  if (bothChannels) {
    process.stdout.write(
      `  CONFLICT   a plugin is installed (${args.plugins}) while this file ` +
        `carries the complete set — both channels fire, so briefings and ` +
        `reminders arrive twice. Keep one: the plugin, or this file.\n`
    );
  }
  logger.info('hooks check', {
    profile: args.profile,
    wired,
    total: entries.length,
    missing: missing.map((entry) => `${entry.event}:${entry.command}`),
    duplicated: duplicated.map(
      ({ entry }) => `${entry.event}:${entry.command}`
    ),
    bothChannels,
  });
  if (missing.length > 0 || duplicated.length > 0 || bothChannels) {
    process.exitCode = 1;
  }
};

/**
 * `hooks` — print the profile's hook set as JSON, one entry per wiring, with the
 * binary spelled however `--bin` asked for it.
 *
 * This is what makes the declaration usable by the installer scripts: they apply
 * the set instead of restating it, so a hook added to the declaration reaches
 * every channel without anyone remembering to edit a shell script too. Each entry
 * also carries its `identity` — the spelling-agnostic substring a script matches
 * on to stay idempotent — so the applier never has to construct it.
 */
export const runHooks = (args: HooksArgs): void => {
  if (args.check) {
    runCheck(args);
    return;
  }
  const rendered = hookManifest(args.profile).map((entry) => ({
    event: entry.event,
    ...(entry.matcher ? { matcher: entry.matcher } : {}),
    command: hookCommand(entry, args.bin),
    identity: hookIdentity(entry),
    ...(entry.timeout === undefined ? {} : { timeout: entry.timeout }),
  }));
  process.stdout.write(`${JSON.stringify(rendered)}\n`);
};
