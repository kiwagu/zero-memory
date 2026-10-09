/**
 * Creates the server's DynamoDB tables in an endpoint (DynamoDB Local for the
 * local Lambda stand): the MCP sessions and the rate-limit counters, both
 * with TTL on `expiresAt`. Idempotent.
 *
 *   bun scripts/lambda-spike/dynamodb-tables.setup.ts <endpoint> <sessions-table> <rate-limit-table>
 */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';

import { createDynamoDbTables } from '../../src/dynamodb.tables.js';

const [endpoint, sessions, rateLimits] = process.argv.slice(2);
if (!endpoint || !sessions || !rateLimits) {
  console.error(
    'usage: dynamodb-tables.setup.ts <endpoint> <sessions-table> <rate-limit-table>'
  );
  process.exit(2);
}

await createDynamoDbTables(new DynamoDBClient({ endpoint }), {
  sessions,
  rateLimits,
});
console.log(`tables ready: ${sessions}, ${rateLimits}`);
