import { defineConfig } from 'vitest/config';

// Every spec here synthesizes a whole CDK app, and the first one in a file also
// pays for loading the construct library: a few seconds on a dev machine, up
// to 20 s on a shared CI runner — well past vitest's 5 s default.
export default defineConfig({
  test: {
    testTimeout: 60_000,
  },
});
