import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import pkg from '../../package.json' with { type: 'json' };
import {
  originPath,
  parseOrigin,
  type PluginOrigin,
} from '../update/update-check.js';

/** Where a reported version came from — the label makes the number honest. */
export type VersionOrigin = 'plugin' | 'build';

export interface WatcherVersion {
  version: string;
  origin: VersionOrigin;
  /** How the user updates this install (only known from the origin file). */
  updateCommand?: string;
  source?: string;
  /**
   * The version the origin file CLAIMS, when it disagrees with the number above.
   *
   * Present only on a mismatch, and it means the file is stale — kept so the
   * discrepancy can be logged instead of silently discarded.
   */
  recordedVersion?: string;
}

const readJson = (path: string): unknown => {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch {
    return null;
  }
};

/**
 * The version this binary reports.
 *
 * GROUND TRUTH IS THE RUNNING CODE, and there are only two things that can
 * describe it: the manifest of the plugin bundle currently executing this
 * process (a hook run sets CLAUDE_PLUGIN_ROOT), and the version compiled INTO
 * the binary. The compiled-in number always answers, so nothing ever prints
 * "unknown".
 *
 * The deploy-time origin file deliberately does NOT supply the number, only
 * provenance — where the install came from and how to update it. It used to
 * outrank the compiled-in version, on the reasoning that a recorded install is
 * more specific than a build. That is wrong whenever the binary is replaced
 * without re-running a deploy script — which is the normal case on a machine
 * that builds from source — and the failure is silent and total: the file keeps
 * asserting an old number, so the binary misreports itself, and every server
 * request carrying the client version reports it too. A stale record can never
 * be more authoritative than the executable answering the question.
 */
export const resolveVersion = (
  env: NodeJS.ProcessEnv = process.env
): WatcherVersion => {
  const root = env.CLAUDE_PLUGIN_ROOT;
  if (root) {
    const manifest = readJson(join(root, '.claude-plugin', 'plugin.json')) as {
      version?: unknown;
    } | null;
    if (manifest && typeof manifest.version === 'string') {
      return { version: manifest.version, origin: 'plugin', source: root };
    }
  }

  const raw = ((): string | null => {
    try {
      return readFileSync(originPath(env), 'utf8');
    } catch {
      return null;
    }
  })();
  const origin: PluginOrigin | null = raw ? parseOrigin(raw) : null;

  return {
    version: pkg.version,
    origin: 'build',
    ...(origin && {
      updateCommand: origin.update_command,
      source: origin.source,
      ...(origin.installed_version !== pkg.version && {
        recordedVersion: origin.installed_version,
      }),
    }),
  };
};

/**
 * Renders `--version` output: the number, then where it came from.
 *
 * A stale deploy record is NAMED rather than dropped. Silently ignoring it would
 * fix the reported number while leaving a file on disk that contradicts it, and
 * the next person to read that file would trust it — which is exactly how the
 * wrong number went unnoticed before.
 */
export const formatVersion = (v: WatcherVersion): string => {
  const lines = [`zero-memory-watcher ${v.version} (${v.origin})`];
  if (v.source) lines.push(`  source:  ${v.source}`);
  if (v.recordedVersion) {
    // The record is provably stale on the one field that can be checked, so its
    // other fields are no more trustworthy — and `update_command` is the harmful
    // one: an install can outlive the very script that wrote the record, in which
    // case printing it hands over a command that cannot work. Say the record is
    // stale instead of offering it.
    lines.push(
      `  note:    the deploy record claims ${v.recordedVersion} — stale, so its ` +
        'update command is not shown; the number above is compiled into this binary'
    );
  } else if (v.updateCommand) {
    lines.push(`  update:  ${v.updateCommand}`);
  }
  return lines.join('\n');
};

export const runVersion = (): void => {
  process.stdout.write(`${formatVersion(resolveVersion())}\n`);
};
