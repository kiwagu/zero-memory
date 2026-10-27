import { configDefaults, defineConfig } from 'vitest/config';

// The DynamoDB adapters' specs need DynamoDB Local and run through
// `bun run test:dynamodb` (vitest.dynamodb.config.ts) instead.
export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, '**/*.dynamodb.spec.ts'],
  },
});
