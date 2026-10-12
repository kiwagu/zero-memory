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
      leaseSeconds: 1200,
      now,
    });
});

const T0 = 1_800_000_000_000;
const minutes = (n: number) => () => T0 + n * 60_000;

describe('DynamoDbWorkClaims against DynamoDB Local', () => {
  it('lets one holder at a time take a key, across instances, until it is released', async () => {
    const [server, otherServer, worker] = [
      claimsAt(minutes(0)),
      claimsAt(minutes(0)),
      claimsAt(minutes(0)),
    ];
    const key = `hygiene-scan#usr_${crypto.randomUUID()}`;

    const token = await server.claim(key);
    expect(token).toEqual(expect.any(String));
    expect(await otherServer.claim(key)).toBeNull();

    await worker.release(key, token!);
    expect(await otherServer.claim(key)).not.toBeNull();
  });

  it('frees a claim whose work never released it once it expires', async () => {
    const key = `benchmark#usr_${crypto.randomUUID()}`;
    expect(await claimsAt(minutes(0)).claim(key)).not.toBeNull();
    expect(await claimsAt(minutes(5)).claim(key)).toBeNull();
    expect(await claimsAt(minutes(11)).claim(key)).not.toBeNull();
  });

  it('never lets a stale holder release or run work a newer claim took over', async () => {
    const key = `hygiene-scan#usr_${crypto.randomUUID()}`;
    const stale = await claimsAt(minutes(0)).claim(key);
    // The first job waited past the expiry; a newer request took the key.
    const current = await claimsAt(minutes(11)).claim(key);
    expect(current).not.toBeNull();

    const worker = claimsAt(minutes(12));
    expect(await worker.confirm(key, stale!)).toBe(false);
    await worker.release(key, stale!);
    expect(await claimsAt(minutes(12)).claim(key)).toBeNull();
    expect(await worker.confirm(key, current!)).toBe(true);
  });

  it('extends a confirmed claim over the run, so a long job keeps it', async () => {
    const key = `benchmark#usr_${crypto.randomUUID()}`;
    const token = await claimsAt(minutes(0)).claim(key);

    // Confirmed at minute 9, the lease runs to minute 29.
    expect(await claimsAt(minutes(9)).confirm(key, token!)).toBe(true);
    expect(await claimsAt(minutes(25)).claim(key)).toBeNull();
    expect(await claimsAt(minutes(30)).claim(key)).not.toBeNull();
  });

  it('lets a worker whose claim expired unclaimed still run it', async () => {
    const key = `benchmark#usr_${crypto.randomUUID()}`;
    const token = await claimsAt(minutes(0)).claim(key);

    expect(await claimsAt(minutes(40)).confirm(key, token!)).toBe(true);
    expect(await claimsAt(minutes(41)).claim(key)).toBeNull();
  });
});
