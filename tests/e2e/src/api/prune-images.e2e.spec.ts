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
const prefix = `zm-e2e-prune-${suffix}/`;
const otherPrefix = `zm-e2e-prune-other-${suffix}/`;
const container = `zm-e2e-prune-${suffix}`;
const created: string[] = [];

const tag = (base: string, name: string): void => {
  docker('tag', base, name);
  created.push(name);
};

test.afterAll(() => {
  spawnSync('docker', ['rm', '-f', container]);
  for (const name of created) {
    spawnSync('docker', ['image', 'rm', name]);
  }
});

test.describe('prune-images.sh', () => {
  test('keeps the release being deployed, the newest other one and any a container uses, and drops the older ones', () => {
    // An image the isolated stack is running right now, so it is present.
    const base = docker(
      'inspect',
      '--format',
      '{{.Image}}',
      'supabase_db_zero-memory-e2e'
    );
    // 0.10.0 sorts after 0.9.0 only in version order, never as text.
    for (const service of ['server', 'web', 'docs']) {
      for (const version of ['0.9.0', '0.10.0', '0.11.0', '0.12.0']) {
        tag(base, `${prefix}zero-memory-${service}:${version}`);
      }
    }
    tag(base, `${prefix}zero-memory-web:latest`);
    tag(base, `${otherPrefix}zero-memory-server:0.1.0`);
    docker('create', '--name', container, `${prefix}zero-memory-web:0.9.0`);

    const result = spawnSync('bash', [script, '0.12.0'], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, ZM_IMAGE_PREFIX: prefix },
    });
    expect(result.status, result.stderr).toBe(0);

    expect(tagsOf(`${prefix}zero-memory-server`)).toEqual(['0.11.0', '0.12.0']);
    expect(tagsOf(`${prefix}zero-memory-docs`)).toEqual(['0.11.0', '0.12.0']);
    // 0.9.0 stays for the container created from it; `latest` is not a
    // release tag, so the script leaves it alone.
    expect(tagsOf(`${prefix}zero-memory-web`)).toEqual([
      '0.11.0',
      '0.12.0',
      '0.9.0',
      'latest',
    ]);
    // Another prefix is another stack's business.
    expect(tagsOf(`${otherPrefix}zero-memory-server`)).toEqual(['0.1.0']);
  });
});
