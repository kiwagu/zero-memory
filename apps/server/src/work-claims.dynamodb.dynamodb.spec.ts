import { entityIdSchemas } from '@workspace/contracts';
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
    expect(entityIdSchemas.work_claim.is(token)).toBe(true);
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

  it('turns away a late job once a newer claim has run and ended', async () => {
    const key = `hygiene-scan#usr_${crypto.randomUUID()}`;
    const late = await claimsAt(minutes(0)).claim(key);
    // The first job waits in the queue past its hold; a newer request claims,
    // its job runs and ends before the first job is finally delivered.
    const newer = await claimsAt(minutes(11)).claim(key);
    expect(await claimsAt(minutes(12)).confirm(key, newer!)).toBe(true);
    await claimsAt(minutes(20)).release(key, newer!);

    expect(await claimsAt(minutes(25)).confirm(key, late!)).toBe(false);
    // The ended claim leaves the key free for the next request.
    expect(await claimsAt(minutes(25)).claim(key)).not.toBeNull();
  });

  it('allows one run per claim, so a repeated delivery of its job skips', async () => {
    const key = `benchmark#usr_${crypto.randomUUID()}`;
    const token = await claimsAt(minutes(0)).claim(key);

    expect(await claimsAt(minutes(1)).confirm(key, token!)).toBe(true);
    expect(await claimsAt(minutes(2)).confirm(key, token!)).toBe(false);
    await claimsAt(minutes(5)).release(key, token!);
    expect(await claimsAt(minutes(6)).confirm(key, token!)).toBe(false);
  });

  it('never lets a job run on a claim it cannot find', async () => {
    const key = `hygiene-scan#usr_${crypto.randomUUID()}`;
    const token = entityIdSchemas.work_claim.create();

    expect(await claimsAt(minutes(0)).confirm(key, token)).toBe(false);
    await claimsAt(minutes(0)).release(key, token);
    expect(await claimsAt(minutes(0)).claim(key)).not.toBeNull();
  });
});
