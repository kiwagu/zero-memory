import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const repoRoot = resolve(new URL('.', import.meta.url).pathname, '../../..');

// The image deps layers enumerate every workspace manifest by hand, while
// bun resolves the workspace globs against the filesystem. A manifest the
// Dockerfile does not COPY makes `bun install --frozen-lockfile` refuse the
// shared lockfile — and that failure surfaces only in the cloud image build,
// after the change has already merged. Both Dockerfiles are asserted here
// because the invariant is one: the lockfile they install from is shared.
const workspaceDirs = ['apps', 'packages', 'tests'];

const workspaceManifests = (): string[] =>
  workspaceDirs
    .flatMap((dir) =>
      readdirSync(join(repoRoot, dir), { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => `${dir}/${entry.name}/package.json`)
    )
    .filter((rel) => existsSync(join(repoRoot, rel)))
    .sort();

const copiedManifests = (dockerfile: string): string[] =>
  [
    ...readFileSync(join(repoRoot, dockerfile), 'utf8').matchAll(
      /^COPY ((?:apps|packages|tests)\/[^/]+\/package\.json) /gm
    ),
  ]
    .map((match) => match[1]!)
    .sort();

describe.each(['apps/server/Dockerfile', 'apps/web/Dockerfile'])(
  'deps layer of %s',
  (dockerfile) => {
    it('copies exactly the workspace manifests the shared lockfile covers', () => {
      expect(copiedManifests(dockerfile)).toEqual(workspaceManifests());
    });
  }
);
