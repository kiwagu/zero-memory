#!/usr/bin/env bun
/**
 * Version-honesty gate for the watcher binary — the deterministic SIGNAL that a
 * release needs a version bump. Run from build-watcher.sh (so it fires at every
 * build/promote, the point where the binary is produced and shipped to clients).
 *
 * The compiled binary reports apps/watcher/package.json's version, and clients
 * see that number when they redeploy — so it must reflect what actually changed.
 * The gate blocks the build if any file in the watcher's RUNTIME dependency
 * closure (apps/watcher + its transitive `@workspace/*` dependencies, source
 * only — devDependencies like eslint/tsconfig never enter the binary) changed
 * since the last version bump WITHOUT a new bump. The relevant set is DERIVED
 * from the dependency graph, never hard-coded, so it cannot drift as packages
 * are added or the watcher's deps change.
 *
 * The gate only detects and signals; the SEMVER LEVEL is a human/agent call —
 * run `bun scripts/bump-watcher-version.ts <patch|minor|major>` and the gate
 * clears. Bypass for a deliberate non-release/local build:
 * ZM_SKIP_WATCHER_VERSION_GATE=1.
 *
 * SECOND CHECK — THE PUBLISHED DIGEST. The repo-root SHA256SUMS names a version
 * and a commit next to the hash it certifies, and guests receive that file with
 * the binary. Only `build-watcher.sh` ever writes it, and nothing in the hosted
 * release path builds the watcher — so for four releases it sat claiming 0.18.1
 * while the source was 0.22.0, and no mechanism said a word. A digest that
 * describes a version nobody ships is worse than no digest: it is a provenance
 * claim that reads as verified. So the same gate refuses when the committed
 * digest's version is not the current one; the fix is the one command that
 * regenerates it, `bash scripts/build-watcher.sh`. Skipped during the build
 * itself (ZM_WATCHER_GATE_PHASE=build) — that run is what refreshes it.
 */
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

if (process.env.ZM_SKIP_WATCHER_VERSION_GATE) {
  console.log('watcher-version-gate: skipped (ZM_SKIP_WATCHER_VERSION_GATE)');
  process.exit(0);
}

const root = join(import.meta.dir, '..');
const git = (...args: string[]): string => {
  try {
    return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
};

// Not a git checkout (e.g. an unpacked release bundle) → no baseline to compare.
if (!git('rev-parse', '--is-inside-work-tree')) {
  console.log('watcher-version-gate: not a git tree — skipped');
  process.exit(0);
}

// Map every workspace package name → its directory, so dependency names resolve
// to paths for the closure walk.
const nameToDir = new Map<string, string>();
for (const area of ['apps', 'packages']) {
  for (const entry of readdirSync(join(root, area), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const rel = `${area}/${entry.name}`;
    try {
      const pkg = JSON.parse(
        readFileSync(join(root, rel, 'package.json'), 'utf8')
      ) as { name?: string };
      if (pkg.name) nameToDir.set(pkg.name, rel);
    } catch {
      // no package.json in this directory
    }
  }
}

// Transitive closure of the watcher's RUNTIME dependencies.
const closure = new Set<string>();
const visit = (dir: string): void => {
  if (closure.has(dir)) return;
  closure.add(dir);
  let pkg: { dependencies?: Record<string, string> };
  try {
    pkg = JSON.parse(readFileSync(join(root, dir, 'package.json'), 'utf8'));
  } catch {
    return;
  }
  for (const dep of Object.keys(pkg.dependencies ?? {})) {
    const depDir = nameToDir.get(dep);
    if (depDir) visit(depDir);
  }
};
visit('apps/watcher');

// A changed path is RELEVANT if it is source (or the package.json) of a closure
// package. Tests do not enter the binary.
const isRelevant = (path: string): boolean => {
  if (path.endsWith('.spec.ts') || path.endsWith('.test.ts')) return false;
  for (const dir of closure) {
    if (path.startsWith(`${dir}/src/`) || path === `${dir}/package.json`) {
      return true;
    }
  }
  return false;
};

const versionOf = (source: string): string =>
  source.match(/"version"\s*:\s*"([^"]+)"/)?.[1] ?? '';

/**
 * The published digest must describe the version that is actually current.
 * Only the header's VERSION is compared, deliberately: the commit line moves
 * with every commit, and demanding a rebuild for each one would make the gate
 * noise instead of a signal.
 */
const digestVersionCheck = (currentVersion: string): void => {
  if (process.env.ZM_WATCHER_GATE_PHASE === 'build') return;
  let digest: string;
  try {
    digest = readFileSync(join(root, 'SHA256SUMS'), 'utf8');
  } catch {
    // No digest committed at all — nothing is claimed, so nothing can lie.
    return;
  }
  const claimed = digest.match(/version\s+([0-9]+\.[0-9]+\.[0-9]+)/)?.[1];
  if (!claimed || claimed === currentVersion) return;
  console.error(
    `\nwatcher-version-gate: the committed SHA256SUMS certifies watcher\n` +
      `${claimed}, but the current version is ${currentVersion}. Guests receive\n` +
      `that file with the binary, so a stale digest is a provenance claim for a\n` +
      `build nobody ships.\n\n` +
      `Regenerate it (it is a side effect of the build):\n` +
      `  bash scripts/build-watcher.sh\n` +
      `Bypass for a deliberate non-release build: ZM_SKIP_WATCHER_VERSION_GATE=1\n`
  );
  process.exit(1);
};

// Baseline = the last commit that changed the version line in the watcher's
// package.json (the last bump). Everything since it is unversioned.
const lastBump = git(
  'log',
  '-1',
  '--format=%H',
  '-G',
  '"version"',
  '--',
  'apps/watcher/package.json'
);
if (!lastBump) {
  console.log('watcher-version-gate: no prior version bump found — skipped');
  process.exit(0);
}

// If the working tree's version already moved past HEAD, a bump is present
// (committed or staged) and covers the delta.
const headVersion = versionOf(git('show', 'HEAD:apps/watcher/package.json'));
const workingVersion = versionOf(
  readFileSync(join(root, 'apps/watcher/package.json'), 'utf8')
);
// The digest is checked against the version that is CURRENT in the tree, and
// independently of the bump check below: a stale digest is just as wrong when
// the closure has not moved at all.
digestVersionCheck(workingVersion);
if (workingVersion !== headVersion) process.exit(0);

// Closure changes since the last bump — a diff against a single commit includes
// the working tree, so uncommitted changes count too.
const changed = git('diff', '--name-only', lastBump)
  .split('\n')
  .filter((path) => path && isRelevant(path));
if (changed.length === 0) process.exit(0);

console.error(
  `\nwatcher-version-gate: the watcher's dependency closure changed since the\n` +
    `last version bump (${headVersion}, commit ${lastBump.slice(0, 9)}), but the\n` +
    `version was not bumped:\n` +
    changed.map((path) => `  - ${path}`).join('\n') +
    `\n\nThe deployed binary reports this version to clients, so it must change.\n` +
    `Pick the semver level and bump both files:\n` +
    `  bun scripts/bump-watcher-version.ts <patch|minor|major>\n` +
    `  (patch = fix/log/internal · minor = new capability · major = ingest-contract break)\n` +
    `Bypass for a deliberate non-release build: ZM_SKIP_WATCHER_VERSION_GATE=1\n`
);
process.exit(1);
