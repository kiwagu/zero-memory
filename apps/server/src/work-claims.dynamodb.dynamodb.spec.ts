import { beforeAll, describe, expect, it } from 'vitest';

import { dynamoDbTestTables } from './dynamodb.test-tables.js';
import { DynamoDbWorkClaims } from './work-claims.dynamodb.js';

let claimsAt: (now: () => number) => DynamoDbWorkClaims;

beforeAll(async () => {
  const { client, names } = await dynamoDbTestTables();
  claimsAt = (now) =>
    new DynamoDbWorkClaims({
      tableName: names.rateLimits,
      client,
      ttlSeconds: 600,
      now,
    });
});

describe('DynamoDbWorkClaims against DynamoDB Local', () => {
  it('lets one holder at a time take a key, across instances, until it is released', async () => {
    const at = () => 1_800_000_000_000;
    const [server, otherServer, worker] = [
      claimsAt(at),
      claimsAt(at),
      claimsAt(at),
    ];
    const key = `hygiene-scan#usr_${crypto.randomUUID()}`;

    expect(await server.claim(key)).toBe(true);
    expect(await otherServer.claim(key)).toBe(false);

    await worker.release(key);
    expect(await otherServer.claim(key)).toBe(true);
  });

  it('frees a claim whose work never released it once it expires', async () => {
    const key = `benchmark#usr_${crypto.randomUUID()}`;
    expect(await claimsAt(() => 1_800_000_000_000).claim(key)).toBe(true);
    expect(await claimsAt(() => 1_800_000_300_000).claim(key)).toBe(false);
    expect(await claimsAt(() => 1_800_000_601_000).claim(key)).toBe(true);
  });
});
