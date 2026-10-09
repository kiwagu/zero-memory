import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import type { IRateLimiter, RateLimitDecision } from '@workspace/mcp-auth';

export interface DynamoDbRateLimiterOptions {
  tableName: string;
  /** Requests allowed per key per window. */
  maxRequests: number;
  /** Window length in seconds. */
  windowSeconds: number;
  client?: DynamoDBClient;
  /** Clock override for tests (epoch milliseconds). */
  now?: () => number;
}

/**
 * Rate-limit counts in a DynamoDB table, shared by every instance of a server
 * that runs as several. Table shape: partition key `bucket`, TTL on
 * `expiresAt`.
 *
 * Windows are aligned to the clock — a window starts at a multiple of its
 * length — where the in-process limiter starts a key's window at its first
 * request. That makes each request one atomic increment of the key's counter
 * for the current window, with no read first. A burst that straddles a window
 * boundary can pass up to twice the limit across the two windows.
 */
export class DynamoDbRateLimiter implements IRateLimiter {
  readonly #table: string;
  readonly #db: DynamoDBDocumentClient;
  readonly #maxRequests: number;
  readonly #windowMs: number;
  readonly #now: () => number;

  constructor(options: DynamoDbRateLimiterOptions) {
    this.#table = options.tableName;
    this.#db = DynamoDBDocumentClient.from(
      options.client ?? new DynamoDBClient({})
    );
    this.#maxRequests = options.maxRequests;
    this.#windowMs = options.windowSeconds * 1000;
    this.#now = options.now ?? Date.now;
  }

  async hit(key: string): Promise<RateLimitDecision> {
    const now = this.#now();
    const windowStart = Math.floor(now / this.#windowMs) * this.#windowMs;
    const windowEnd = windowStart + this.#windowMs;
    const { Attributes } = await this.#db.send(
      new UpdateCommand({
        TableName: this.#table,
        Key: { bucket: `${key}#${windowStart}` },
        UpdateExpression:
          'SET expiresAt = if_not_exists(expiresAt, :expiresAt) ADD #count :one',
        ExpressionAttributeNames: { '#count': 'count' },
        ExpressionAttributeValues: {
          ':one': 1,
          // Kept a minute past the window; TTL deletes it later still.
          ':expiresAt': Math.ceil(windowEnd / 1000) + 60,
        },
        ReturnValues: 'UPDATED_NEW',
      })
    );
    const count = Number(Attributes?.count ?? 0);
    if (count <= this.#maxRequests) {
      return { allowed: true, retryAfterSeconds: 0 };
    }
    return {
      allowed: false,
      retryAfterSeconds: Math.max(1, Math.ceil((windowEnd - now) / 1000)),
    };
  }
}
