/**
 * prune-images.sh against the local Docker engine: before a deploy pulls a
 * release, the host drops this stack's older release images so the pull has
 * room, and keeps what a rollback or a container still needs.
 *
 * The spec drives the real script. Its "releases" are extra tags on one image
 * the isolated stack already runs, under a registry prefix no other image
 * uses, so creating and removing them costs no disk and cannot touch any
 * image outside the test.
 */
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, test } from '@playwright/test';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const script = join(root, 'infra/prod/scripts/prune-images.sh');

const docker = (...args: string[]): string => {
  const result = spawnSync('docker', args, { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`docker ${args.join(' ')} failed: ${result.stderr}`);
  }
  return result.stdout.trim();
};

/** Every tag Docker holds for a repository, sorted for a stable compare. */
const tagsOf = (repository: string): string[] =>
  docker('image', 'ls', repository, '--format', '{{.Tag}}')
    .split('\n')
    .filter(Boolean)
    .sort();

const suffix = randomBytes(4).toString('hex');
const container = `zm-e2e-prune-${suffix}`;
const created: string[] = [];

/** A registry prefix of this test's own, so no other image can match it. */
const prefixFor = (name: string): string => `zm-e2e-prune-${name}-${suffix}/`;

const tag = (name: string): void => {
  // An image the isolated stack is running right now, so it is present.
  const base = docker(
    'inspect',
    '--format',
    '{{.Image}}',
    'supabase_db_zero-memory-e2e'
  );
  docker('tag', base, name);
  created.push(name);
};

const versions = (count: number): string[] =>
  Array.from({ length: count }, (_, index) => `0.${index + 1}.0`);

/** Runs the script for a deploy of `release`; `keep` unset means the default. */
const prune = (prefix: string, release: string, keep?: string): void => {
  const env: NodeJS.ProcessEnv = { ...process.env, ZM_IMAGE_PREFIX: prefix };
  delete env.ZM_KEEP_RELEASES;
  if (keep !== undefined) {
    env.ZM_KEEP_RELEASES = keep;
  }
  const result = spawnSync('bash', [script, release], {
    cwd: root,
    encoding: 'utf8',
    env,
  });
  expect(result.status, result.stderr).toBe(0);
};

test.afterAll(() => {
  spawnSync('docker', ['rm', '-f', container]);
  for (const name of created) {
    spawnSync('docker', ['image', 'rm', name]);
  }
});

test.describe('prune-images.sh', () => {
  test('keeps five releases by default, and any tag a container uses', () => {
    const prefix = prefixFor('default');
    const other = prefixFor('other');
    // Twelve releases: 0.10.0 to 0.12.0 sort after 0.9.0 only in version
    // order, never as text.
    const all = versions(12);
    for (const service of ['server', 'web', 'docs']) {
      for (const version of all) {
        tag(`${prefix}zero-memory-${service}:${version}`);
      }
    }
    tag(`${prefix}zero-memory-web:latest`);
    tag(`${other}zero-memory-server:0.1.0`);
    docker('create', '--name', container, `${prefix}zero-memory-web:0.1.0`);

    prune(prefix, '0.12.0');

    // The release being deployed and the four newest others.
    const kept = all.slice(7).sort();
    expect(tagsOf(`${prefix}zero-memory-server`)).toEqual(kept);
    expect(tagsOf(`${prefix}zero-memory-docs`)).toEqual(kept);
    // 0.1.0 stays for the container created from it; `latest` is not a
    // release tag, so the script leaves it alone.
    expect(tagsOf(`${prefix}zero-memory-web`)).toEqual(
      [...kept, '0.1.0', 'latest'].sort()
    );
    // Another prefix is another stack's business.
    expect(tagsOf(`${other}zero-memory-server`)).toEqual(['0.1.0']);
  });

  test('honours ZM_KEEP_RELEASES, and keeps an older release that is being deployed', () => {
    const prefix = prefixFor('keep');
    for (const version of versions(8)) {
      tag(`${prefix}zero-memory-server:${version}`);
    }

    // A rollback to 0.5.0 with three releases to keep.
    prune(prefix, '0.5.0', '3');

    expect(tagsOf(`${prefix}zero-memory-server`)).toEqual([
      '0.5.0',
      '0.7.0',
      '0.8.0',
    ]);
  });
});
