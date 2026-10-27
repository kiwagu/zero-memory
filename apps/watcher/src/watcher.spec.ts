import { describe, expect, it } from 'vitest';

import { decodeProjectDir } from './watcher.js';

describe('decodeProjectDir', () => {
  it('decodes flattened transcript directory names (best effort)', () => {
    expect(decodeProjectDir('-home-dev-repos-alpha')).toBe(
      '/home/dev/repos/alpha'
    );
    expect(decodeProjectDir('not-flattened')).toBeUndefined();
  });
});
