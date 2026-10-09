/**
 * Creates the MCP session table in a DynamoDB endpoint (DynamoDB Local for the
 * spike): partition key `sessionId`, the `byOwner` index for the per-user
 * cap, TTL on `expiresAt`. Idempotent.
 *
 *   bun scripts/lambda-spike/session-table.setup.ts <endpoint> <table>
 */
import {
  CreateTableCommand,
  DynamoDBClient,
  ResourceInUseException,
  UpdateTimeToLiveCommand,
} from '@aws-sdk/client-dynamodb';

import { MCP_SESSION_OWNER_INDEX } from '../../src/mcp-session.dynamodb-store.js';

const [endpoint, table] = process.argv.slice(2);
if (!endpoint || !table) {
  console.error('usage: session-table.setup.ts <endpoint> <table>');
  process.exit(2);
}

const client = new DynamoDBClient({ endpoint });
try {
  await client.send(
    new CreateTableCommand({
      TableName: table,
      BillingMode: 'PAY_PER_REQUEST',
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
    })
  );
  console.log(`created ${table}`);
} catch (error) {
  if (!(error instanceof ResourceInUseException)) {
    throw error;
  }
  console.log(`${table} already exists`);
}
await client.send(
  new UpdateTimeToLiveCommand({
    TableName: table,
    TimeToLiveSpecification: { AttributeName: 'expiresAt', Enabled: true },
  })
);
console.log('ttl on expiresAt');
