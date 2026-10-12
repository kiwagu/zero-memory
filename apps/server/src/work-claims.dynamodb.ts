import {
  ConditionalCheckFailedException,
  DynamoDBClient,
} from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  PutCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import {
  newWorkClaimToken,
  type IWorkClaims,
  type WorkClaimToken,
} from '@workspace/mcp';

export interface DynamoDbWorkClaimsOptions {
  /** A table keyed on `bucket` with TTL on `expiresAt` (the rate-limit one). */
  tableName: string;
  /** How long a claim holds while its work waits to start. */
  ttlSeconds?: number;
  /** How long a claim holds once the worker confirmed it and runs the work. */
  leaseSeconds?: number;
  /**
   * How long a claim's record outlives its hold: longer than a handed-off job
   * may wait to be delivered, so a late job still finds the record that tells
   * it whether it may run.
   */
  evidenceSeconds?: number;
  client?: DynamoDBClient;
  /** Clock override for tests (epoch milliseconds). */
  now?: () => number;
}

/** Where a claim stands: taken, its work running, or ended. */
type ClaimState = 'queued' | 'running' | 'released';

/**
 * Work claims shared by every instance and by the worker that runs the work,
 * as items in a DynamoDB table. Taking one is a conditional write that
 * succeeds only when no claim holds the key (none yet, its hold ran out, or
 * it was released), so two requests cannot both start the same scan, and it
 * returns a token the handed-off work carries.
 *
 * The worker confirms the claim before it spends anything, and confirming is
 * the one start the claim allows: it succeeds only while the key still holds
 * this token's claim, not yet started, and it extends the hold over the run.
 * Any other answer means the job is obsolete — a newer request took the key,
 * or this claim's work already ran — and the job skips rather than repeat
 * paid work. Release marks the claim ended instead of deleting it, so the
 * key is free at once while the record stays to turn away a late or repeated
 * delivery of the same job; the table's TTL removes it after
 * `evidenceSeconds`, by when no such delivery can still arrive.
 */
export class DynamoDbWorkClaims implements IWorkClaims {
  readonly #table: string;
  readonly #db: DynamoDBDocumentClient;
  readonly #ttlSeconds: number;
  readonly #leaseSeconds: number;
  readonly #evidenceSeconds: number;
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
    // The jobs function drops an event older than an hour undelivered.
    this.#evidenceSeconds = options.evidenceSeconds ?? 2 * 60 * 60;
    this.#now = options.now ?? Date.now;
  }

  async claim(key: string): Promise<WorkClaimToken | null> {
    const now = this.#seconds();
    const token = newWorkClaimToken();
    const heldUntil = now + this.#ttlSeconds;
    const state: ClaimState = 'queued';
    try {
      await this.#db.send(
        new PutCommand({
          TableName: this.#table,
          Item: {
            bucket: this.#bucket(key),
            token,
            state,
            heldUntil,
            expiresAt: heldUntil + this.#evidenceSeconds,
          },
          ConditionExpression:
            'attribute_not_exists(#bucket) OR heldUntil < :now OR #state = :released',
          ExpressionAttributeNames: { '#bucket': 'bucket', '#state': 'state' },
          ExpressionAttributeValues: {
            ':now': now,
            ':released': 'released' satisfies ClaimState,
          },
        })
      );
      return token;
    } catch (error) {
      return failedCondition(error, null);
    }
  }

  /**
   * Whether the worker holding `token` may run the work: true once per claim,
   * and the claim then holds over the whole run.
   */
  async confirm(key: string, token: WorkClaimToken): Promise<boolean> {
    const heldUntil = this.#seconds() + this.#leaseSeconds;
    try {
      await this.#update(
        key,
        token,
        'SET #state = :running, heldUntil = :heldUntil, expiresAt = :expiresAt',
        '#token = :token AND #state = :queued',
        {
          ':running': 'running' satisfies ClaimState,
          ':queued': 'queued' satisfies ClaimState,
          ':heldUntil': heldUntil,
          ':expiresAt': heldUntil + this.#evidenceSeconds,
        }
      );
      return true;
    } catch (error) {
      return failedCondition(error, false);
    }
  }

  async release(key: string, token: WorkClaimToken): Promise<void> {
    try {
      await this.#update(
        key,
        token,
        'SET #state = :released',
        '#token = :token',
        {
          ':released': 'released' satisfies ClaimState,
        }
      );
    } catch (error) {
      // Someone else's claim by now, or already gone: nothing of ours to end.
      failedCondition(error, undefined);
    }
  }

  #seconds(): number {
    return Math.floor(this.#now() / 1000);
  }

  #bucket(key: string): string {
    return `claim#${key}`;
  }

  async #update(
    key: string,
    token: WorkClaimToken,
    update: string,
    condition: string,
    values: Record<string, unknown>
  ): Promise<void> {
    await this.#db.send(
      new UpdateCommand({
        TableName: this.#table,
        Key: { bucket: this.#bucket(key) },
        UpdateExpression: update,
        // An absent item fails the token check, so no update creates one.
        ConditionExpression: condition,
        ExpressionAttributeNames: { '#token': 'token', '#state': 'state' },
        ExpressionAttributeValues: { ':token': token, ...values },
      })
    );
  }
}

/** The answer for a write whose condition failed; any other error throws. */
const failedCondition = <T>(error: unknown, answer: T): T => {
  if (error instanceof ConditionalCheckFailedException) {
    return answer;
  }
  throw error;
};
