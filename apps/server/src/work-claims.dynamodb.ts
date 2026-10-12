import {
  ConditionalCheckFailedException,
  DynamoDBClient,
} from '@aws-sdk/client-dynamodb';
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  PutCommand,
} from '@aws-sdk/lib-dynamodb';
import type { IWorkClaims } from '@workspace/mcp';

export interface DynamoDbWorkClaimsOptions {
  /** A table keyed on `bucket` with TTL on `expiresAt` (the rate-limit one). */
  tableName: string;
  /** How long a claim holds when its work never releases it. */
  ttlSeconds?: number;
  client?: DynamoDBClient;
  /** Clock override for tests (epoch milliseconds). */
  now?: () => number;
}

/**
 * Work claims shared by every instance and by the worker that runs the work,
 * as items in a DynamoDB table: taking one is a conditional write that
 * succeeds only when no live claim exists, so two requests cannot both start
 * the same scan. The worker deletes the item when the work ends. A claim
 * whose work died is free again once its expiry passes, whether or not
 * DynamoDB's TTL has removed the item yet.
 */
export class DynamoDbWorkClaims implements IWorkClaims {
  readonly #table: string;
  readonly #db: DynamoDBDocumentClient;
  readonly #ttlSeconds: number;
  readonly #now: () => number;

  constructor(options: DynamoDbWorkClaimsOptions) {
    this.#table = options.tableName;
    this.#db = DynamoDBDocumentClient.from(
      options.client ?? new DynamoDBClient({})
    );
    // Longer than a job may run (15 minutes) plus a wait in Lambda's queue.
    this.#ttlSeconds = options.ttlSeconds ?? 30 * 60;
    this.#now = options.now ?? Date.now;
  }

  async claim(key: string): Promise<boolean> {
    const now = Math.floor(this.#now() / 1000);
    try {
      await this.#db.send(
        new PutCommand({
          TableName: this.#table,
          Item: { bucket: `claim#${key}`, expiresAt: now + this.#ttlSeconds },
          ConditionExpression:
            'attribute_not_exists(#bucket) OR expiresAt < :now',
          ExpressionAttributeNames: { '#bucket': 'bucket' },
          ExpressionAttributeValues: { ':now': now },
        })
      );
      return true;
    } catch (error) {
      if (error instanceof ConditionalCheckFailedException) {
        return false;
      }
      throw error;
    }
  }

  async release(key: string): Promise<void> {
    await this.#db.send(
      new DeleteCommand({
        TableName: this.#table,
        Key: { bucket: `claim#${key}` },
      })
    );
  }
}
