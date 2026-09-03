import { defineConfig } from 'vitest/config';

// Pure-logic unit tests only (markdown render/parse, zip). The Next app itself
// is exercised by the e2e suite; these specs need no DOM or bundler, just node.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['lib/**/*.spec.ts'],
  },
});
