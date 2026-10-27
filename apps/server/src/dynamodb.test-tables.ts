import { DynamoDBClient } from '@aws-sdk/client-dynamodb';

import {
  createDynamoDbTables,
  type DynamoDbTableNames,
} from './dynamodb.tables.js';

/**
 * A client of the DynamoDB Local the adapters' specs run against, and a fresh
 * pair of tables for one spec file. `bun run test:dynamodb` starts DynamoDB
 * Local and passes its address in ZM_DYNAMODB_TEST_ENDPOINT.
 */
export const dynamoDbTestTables = async (): Promise<{
  client: DynamoDBClient;
  names: DynamoDbTableNames;
}> => {
  const endpoint = process.env.ZM_DYNAMODB_TEST_ENDPOINT;
  if (!endpoint) {
    throw new Error(
      'ZM_DYNAMODB_TEST_ENDPOINT is not set: run these specs with `bun run test:dynamodb`.'
    );
  }
  const client = new DynamoDBClient({
    endpoint,
    region: 'eu-north-1',
    credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
  });
  const suffix = crypto.randomUUID().slice(0, 8);
  const names = {
    sessions: `sessions-${suffix}`,
    rateLimits: `rate-limits-${suffix}`,
  };
  await createDynamoDbTables(client, names);
  return { client, names };
};
