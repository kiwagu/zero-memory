import { randomUUID } from 'node:crypto';

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
  /** How long a claim holds while its work waits to start. */
  ttlSeconds?: number;
  /** How long a claim holds once the worker confirmed it and runs the work. */
  leaseSeconds?: number;
  client?: DynamoDBClient;
  /** Clock override for tests (epoch milliseconds). */
  now?: () => number;
}

/**
 * Work claims shared by every instance and by the worker that runs the work,
 * as items in a DynamoDB table. Taking one is a conditional write that
 * succeeds only when no live claim exists, so two requests cannot both start
 * the same scan, and it returns a token the handed-off work carries.
 *
 * The worker confirms the claim before it spends anything: still its token
 * (or nobody's, once expired and removed) and it extends the claim over the
 * run; another token means a newer request took the key after this claim
 * expired, so the older job skips rather than repeat paid work. Release
 * deletes the item only while it still carries the releasing token.
 */
export class DynamoDbWorkClaims implements IWorkClaims {
  readonly #table: string;
  readonly #db: DynamoDBDocumentClient;
  readonly #ttlSeconds: number;
  readonly #leaseSeconds: number;
  readonly #now: () => number;

  constructor(options: DynamoDbWorkClaimsOptions) {
    this.#table = options.tableName;
    this.#db = DynamoDBDocumentClient.from(
      options.client ?? new DynamoDBClient({})
    );
    // A handed-off job may wait in Lambda's queue behind others first.
    this.#ttlSeconds = options.ttlSeconds ?? 30 * 60;
    // Longer than a job may run (15 minutes).
    this.#leaseSeconds = options.leaseSeconds ?? 20 * 60;
    this.#now = options.now ?? Date.now;
  }

  async claim(key: string): Promise<string | null> {
    const now = this.#seconds();
    const token = randomUUID();
    const taken = await this.#conditionalPut(
      key,
      token,
      now + this.#ttlSeconds,
      'attribute_not_exists(#bucket) OR expiresAt < :now',
      { ':now': now }
    );
    return taken ? token : null;
  }

  /**
   * Whether the worker holding `token` may run the work, and if so the claim
   * now lasts the whole run.
   */
  async confirm(key: string, token: string): Promise<boolean> {
    const now = this.#seconds();
    return this.#conditionalPut(
      key,
      token,
      now + this.#leaseSeconds,
      'attribute_not_exists(#bucket) OR #token = :token',
      { ':token': token }
    );
  }

  async release(key: string, token: string): Promise<void> {
    try {
      await this.#db.send(
        new DeleteCommand({
          TableName: this.#table,
          Key: { bucket: `claim#${key}` },
          ConditionExpression: '#token = :token',
          ExpressionAttributeNames: { '#token': 'token' },
          ExpressionAttributeValues: { ':token': token },
        })
      );
    } catch (error) {
      // Someone else's claim by now, or already gone: nothing of ours to end.
      if (!(error instanceof ConditionalCheckFailedException)) {
        throw error;
      }
    }
  }

  #seconds(): number {
    return Math.floor(this.#now() / 1000);
  }

  async #conditionalPut(
    key: string,
    token: string,
    expiresAt: number,
    condition: string,
    values: Record<string, unknown>
  ): Promise<boolean> {
    try {
      await this.#db.send(
        new PutCommand({
          TableName: this.#table,
          Item: { bucket: `claim#${key}`, token, expiresAt },
          ConditionExpression: condition,
          ExpressionAttributeNames: {
            '#bucket': 'bucket',
            ...(condition.includes('#token') ? { '#token': 'token' } : {}),
          },
          ExpressionAttributeValues: values,
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
}
