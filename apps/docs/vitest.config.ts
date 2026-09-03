import { defineConfig } from 'vitest/config';

// Pure-logic unit tests only (the upload contract). The site itself is
// exercised by the e2e suite; these specs need no DOM or bundler, just node.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['lib/**/*.spec.ts'],
  },
});
