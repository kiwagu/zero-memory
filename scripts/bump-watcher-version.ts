#!/usr/bin/env bun
/**
 * Bump the watcher's semantic version in lockstep across every file that must
 * agree — apps/watcher/package.json and EVERY client plugin manifest
 * (build-watcher.sh fails the build if any of them drift). One number across all
 * of them is what makes a support report actionable: the version a reporter can
 * see is the plugin's, and it has to name one build rather than one client
 * family. The SEMVER LEVEL is a deliberate call, not derived: pass patch | minor
 * | major. Run this when the version gate (scripts/watcher-version-gate.ts)
 * signals that the watcher's relevant dependency closure changed since the last
 * bump.
 *
 *   bun scripts/bump-watcher-version.ts patch|minor|major
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const LEVELS = ['patch', 'minor', 'major'] as const;
type Level = (typeof LEVELS)[number];

const root = join(import.meta.dir, '..');

/**
 * Every client plugin manifest, discovered rather than listed — a plugin added
 * later joins the lockstep by existing. A hard-coded list is how the Codex and
 * Cursor manifests stayed at 0.1.0 while the binary they ship moved through
 * fourteen releases.
 *
 * Two manifest shapes, because the clients disagree: Claude / Codex / Cursor
 * each keep a JSON manifest in a dot-directory (`.<client>-plugin/plugin.json`),
 * while a Hermes plugin's manifest is a `plugin.yaml` at the plugin root. Both
 * carry the same `version` field and both must move together, so discovery
 * covers both rather than privileging the shape that happened to come first.
 */
const pluginManifests = (): string[] =>
  readdirSync(join(root, 'plugins'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((plugin) => {
      const inner = readdirSync(join(root, 'plugins', plugin.name), {
        withFileTypes: true,
      });
      const jsonManifests = inner
        .filter(
          (entry) => entry.isDirectory() && /^\..+-plugin$/.test(entry.name)
        )
        .map((entry) => `plugins/${plugin.name}/${entry.name}/plugin.json`);
      const yamlManifests = inner
        .filter((entry) => entry.isFile() && entry.name === 'plugin.yaml')
        .map(() => `plugins/${plugin.name}/plugin.yaml`);
      return [...jsonManifests, ...yamlManifests];
    })
    .sort();

const FILES = ['apps/watcher/package.json', ...pluginManifests()];

const level = process.argv[2];
if (!level || !(LEVELS as readonly string[]).includes(level)) {
  console.error(
    `usage: bun scripts/bump-watcher-version.ts <${LEVELS.join('|')}>`
  );
  process.exit(1);
}

/**
 * The `version` field of a manifest, in either shape. JSON quotes it
 * (`"version": "1.2.3"`), YAML does not (`version: 1.2.3`) — one reader for
 * both, chosen by extension so a YAML file can never be matched by the JSON
 * pattern by accident.
 */
const VERSION_PATTERNS: Record<'json' | 'yaml', RegExp> = {
  json: /"version"\s*:\s*"([^"]+)"/,
  yaml: /^version:\s*(\S+)\s*$/m,
};

const manifestShape = (rel: string): 'json' | 'yaml' =>
  rel.endsWith('.yaml') || rel.endsWith('.yml') ? 'yaml' : 'json';

const readVersion = (rel: string): string => {
  const match = readFileSync(join(root, rel), 'utf8').match(
    VERSION_PATTERNS[manifestShape(rel)]
  );
  if (!match) throw new Error(`no "version" field in ${rel}`);
  return match[1]!;
};

const bump = (version: string, lvl: Level): string => {
  const match = version.match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!match) throw new Error(`version "${version}" is not x.y.z`);
  let [major, minor, patch] = [
    Number(match[1]),
    Number(match[2]),
    Number(match[3]),
  ];
  if (lvl === 'major') {
    major += 1;
    minor = 0;
    patch = 0;
  } else if (lvl === 'minor') {
    minor += 1;
    patch = 0;
  } else {
    patch += 1;
  }
  return `${major}.${minor}.${patch}`;
};

const current = readVersion(FILES[0]!);
// Refuse to bump over pre-existing drift — that would paper over a real problem.
for (const rel of FILES) {
  const found = readVersion(rel);
  if (found !== current) {
    console.error(
      `version drift before bump: ${FILES[0]} (${current}) != ${rel} (${found}) — reconcile first`
    );
    process.exit(1);
  }
}

const next = bump(current, level as Level);
// Targeted replacement of the FIRST "version" field preserves each file's exact
// formatting (a full parse→stringify would reflow it) — in the shape that
// file actually uses.
for (const rel of FILES) {
  const path = join(root, rel);
  const source = readFileSync(path, 'utf8');
  const rewritten =
    manifestShape(rel) === 'yaml'
      ? source.replace(/^(version:\s*)\S+\s*$/m, `$1${next}`)
      : source.replace(/("version"\s*:\s*")[^"]+(")/, `$1${next}$2`);
  writeFileSync(path, rewritten);
}
console.log(`watcher version: ${current} → ${next} (${FILES.join(', ')})`);
