import { defineConfig } from 'vitest/config';

// The DynamoDB adapters against DynamoDB Local; see scripts/dynamodb-local.test.sh.
export default defineConfig({
  test: {
    include: ['src/**/*.dynamodb.spec.ts'],
  },
});
