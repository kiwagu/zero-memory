import {
  CreateTableCommand,
  ResourceInUseException,
  UpdateTimeToLiveCommand,
  type CreateTableCommandInput,
  type DynamoDBClient,
} from '@aws-sdk/client-dynamodb';

import { MCP_SESSION_OWNER_INDEX } from './mcp-session.dynamodb-store.js';

/**
 * The shapes of the server's DynamoDB tables, for whatever creates them
 * outside the deployment's own infrastructure code: the local Lambda stand
 * and the adapters' tests against DynamoDB Local. Both expire items through
 * TTL on `expiresAt`.
 */
const tableShapes = {
  /** MCP sessions: by id, plus one owner's sessions oldest first. */
  sessions: {
    AttributeDefinitions: [
      { AttributeName: 'sessionId', AttributeType: 'S' },
      { AttributeName: 'ownerUserEntityId', AttributeType: 'S' },
      { AttributeName: 'lastSeenAt', AttributeType: 'N' },
    ],
    KeySchema: [{ AttributeName: 'sessionId', KeyType: 'HASH' }],
    GlobalSecondaryIndexes: [
      {
        IndexName: MCP_SESSION_OWNER_INDEX,
        KeySchema: [
          { AttributeName: 'ownerUserEntityId', KeyType: 'HASH' },
          { AttributeName: 'lastSeenAt', KeyType: 'RANGE' },
        ],
        Projection: { ProjectionType: 'KEYS_ONLY' },
      },
    ],
  },
  /** Rate-limit counters: one item per key and window. */
  rateLimits: {
    AttributeDefinitions: [{ AttributeName: 'bucket', AttributeType: 'S' }],
    KeySchema: [{ AttributeName: 'bucket', KeyType: 'HASH' }],
  },
} satisfies Record<string, Omit<CreateTableCommandInput, 'TableName'>>;

export type DynamoDbTableNames = Record<keyof typeof tableShapes, string>;

/** Creates the tables that do not exist yet and turns their TTL on. */
export const createDynamoDbTables = async (
  client: DynamoDBClient,
  names: DynamoDbTableNames
): Promise<void> => {
  for (const [role, shape] of Object.entries(tableShapes)) {
    const tableName = names[role as keyof DynamoDbTableNames];
    try {
      await client.send(
        new CreateTableCommand({
          ...shape,
          TableName: tableName,
          BillingMode: 'PAY_PER_REQUEST',
        })
      );
    } catch (error) {
      if (!(error instanceof ResourceInUseException)) {
        throw error;
      }
    }
    await client.send(
      new UpdateTimeToLiveCommand({
        TableName: tableName,
        TimeToLiveSpecification: { AttributeName: 'expiresAt', Enabled: true },
      })
    );
  }
};
