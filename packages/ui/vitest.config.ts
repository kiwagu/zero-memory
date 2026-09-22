import path from 'node:path';

import { defineConfig } from 'vitest/config';

// Display logic of the shared UI: pure helpers and components rendered to
// static markup. No DOM is needed — react-dom/server renders in node.
export default defineConfig({
  esbuild: { jsx: 'automatic' },
  resolve: {
    alias: [
      {
        find: /^@workspace\/ui\/(.*)$/,
        replacement: path.resolve(__dirname, 'src/$1'),
      },
    ],
  },
  test: {
    environment: 'node',
    include: ['src/**/*.spec.{ts,tsx}'],
  },
});
