import { beforeAll, describe, expect, it } from 'vitest';

import { dynamoDbTestTables } from './dynamodb.test-tables.js';
import { DynamoDbRateLimiter } from './rate-limit.dynamodb-limiter.js';

let limiterFor: (now: () => number) => DynamoDbRateLimiter;

beforeAll(async () => {
  const { client, names } = await dynamoDbTestTables();
  limiterFor = (now) =>
    new DynamoDbRateLimiter({
      tableName: names.rateLimits,
      client,
      maxRequests: 3,
      windowSeconds: 60,
      now,
    });
});

describe('DynamoDbRateLimiter against DynamoDB Local', () => {
  it('limits a key across limiters sharing the table, as instances do', async () => {
    // 20 s into a window: windows start at multiples of 60 s.
    const at = () => 1_800_000_020_000;
    const [a, b] = [limiterFor(at), limiterFor(at)];
    const key = `203.0.113.30:token:${crypto.randomUUID()}`;
    expect((await a.hit(key)).allowed).toBe(true);
    expect((await b.hit(key)).allowed).toBe(true);
    expect((await a.hit(key)).allowed).toBe(true);
    const over = await b.hit(key);
    expect(over.allowed).toBe(false);
    expect(over.retryAfterSeconds).toBe(40);
  });

  it('keeps keys apart', async () => {
    const limiter = limiterFor(() => 1_800_000_000_000);
    const key = `203.0.113.31:token:${crypto.randomUUID()}`;
    for (let i = 0; i < 3; i += 1) {
      await limiter.hit(key);
    }
    expect((await limiter.hit(key)).allowed).toBe(false);
    expect((await limiter.hit(`${key}:other`)).allowed).toBe(true);
  });

  it('starts a fresh count in the next window', async () => {
    let now = 1_800_000_000_000;
    const limiter = limiterFor(() => now);
    const key = `203.0.113.32:register:${crypto.randomUUID()}`;
    for (let i = 0; i < 3; i += 1) {
      await limiter.hit(key);
    }
    expect((await limiter.hit(key)).allowed).toBe(false);
    now += 60_000;
    expect((await limiter.hit(key)).allowed).toBe(true);
  });
});
