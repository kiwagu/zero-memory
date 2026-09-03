import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const repoRoot = resolve(new URL('.', import.meta.url).pathname, '../../..');

const versionOf = (manifest: string): string =>
  JSON.parse(readFileSync(join(repoRoot, manifest), 'utf8')).version;

// The root version is the release lever: the sync script tags the mirror
// with it, CI builds images from that tag, and each app falls back to its
// OWN manifest version when running outside an image. If the three drift,
// a local build reports a version that was never released.
describe('release version', () => {
  it('is semver at the root', () => {
    expect(versionOf('package.json')).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it.each(['apps/server/package.json', 'apps/web/package.json'])(
    'is matched by %s',
    (manifest) => {
      expect(versionOf(manifest)).toBe(versionOf('package.json'));
    }
  );
});
