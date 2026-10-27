import {
  ConditionalCheckFailedException,
  DynamoDBClient,
} from '@aws-sdk/client-dynamodb';
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';

import {
  MCP_SESSION_IDLE_TTL_MS,
  type IMcpSessionStore,
  type McpSessionRecord,
} from './mcp-session.store.js';
import { maxSessionsPerUserFromEnv } from './session-cap.js';

/** The index that lists one owner's sessions, oldest first. */
export const MCP_SESSION_OWNER_INDEX = 'byOwner';

export interface DynamoDbMcpSessionStoreOptions {
  tableName: string;
  client?: DynamoDBClient;
}

interface SessionItem {
  sessionId: string;
  ownerUserEntityId: string;
  clientName: string | null;
  defaultScope?: string;
  lastSeenAt: number;
  /** Epoch seconds; the table's TTL attribute. */
  expiresAt: number;
}

const toRecord = (item: SessionItem): McpSessionRecord => ({
  sessionId: item.sessionId,
  ownerUserEntityId: item.ownerUserEntityId,
  clientName: item.clientName ?? null,
  defaultScope: item.defaultScope,
  lastSeenAt: item.lastSeenAt,
});

/**
 * Sessions in a DynamoDB table, for a server whose requests land on instances
 * that come and go. Table shape: partition key `sessionId`; a global secondary
 * index `byOwner` (partition `ownerUserEntityId`, sort `lastSeenAt`) for the
 * per-user cap; TTL on `expiresAt`.
 *
 * DynamoDB's TTL removes expired items lazily (within days), so every read
 * checks `expiresAt` itself. There is no global cap: the global one guards a
 * process's memory, and a table has none to guard.
 */
export class DynamoDbMcpSessionStore implements IMcpSessionStore {
  readonly #table: string;
  readonly #db: DynamoDBDocumentClient;
  readonly #maxSessionsPerUser = maxSessionsPerUserFromEnv();

  constructor(options: DynamoDbMcpSessionStoreOptions) {
    this.#table = options.tableName;
    this.#db = DynamoDBDocumentClient.from(
      options.client ?? new DynamoDBClient({}),
      { marshallOptions: { removeUndefinedValues: true } }
    );
  }

  async open(record: McpSessionRecord): Promise<string[]> {
    const item: SessionItem = {
      ...record,
      expiresAt: this.#expiresAt(record.lastSeenAt),
    };
    await this.#db.send(
      new PutCommand({
        TableName: this.#table,
        Item: item,
        ConditionExpression: 'attribute_not_exists(sessionId)',
      })
    );
    return this.#dropOwnOverCap(record.ownerUserEntityId);
  }

  async resume(
    sessionId: string,
    ownerUserEntityId: string,
    at: number
  ): Promise<McpSessionRecord | undefined> {
    // One round trip restarts the idle clock and returns the record, and only
    // when the session exists, belongs to the caller and has not idled out.
    try {
      const { Attributes } = await this.#db.send(
        new UpdateCommand({
          TableName: this.#table,
          Key: { sessionId },
          UpdateExpression: 'SET lastSeenAt = :at, expiresAt = :expiresAt',
          ConditionExpression:
            'attribute_exists(sessionId) AND ownerUserEntityId = :owner AND expiresAt > :now',
          ExpressionAttributeValues: {
            ':at': at,
            ':expiresAt': this.#expiresAt(at),
            ':owner': ownerUserEntityId,
            ':now': Math.floor(at / 1000),
          },
          ReturnValues: 'ALL_NEW',
        })
      );
      return Attributes ? toRecord(Attributes as SessionItem) : undefined;
    } catch (error) {
      if (error instanceof ConditionalCheckFailedException) {
        return undefined;
      }
      throw error;
    }
  }

  async attachScope(sessionId: string, scope: string): Promise<void> {
    try {
      await this.#db.send(
        new UpdateCommand({
          TableName: this.#table,
          Key: { sessionId },
          UpdateExpression: 'SET defaultScope = :scope',
          ConditionExpression: 'attribute_exists(sessionId)',
          ExpressionAttributeValues: { ':scope': scope },
        })
      );
    } catch (error) {
      if (!(error instanceof ConditionalCheckFailedException)) {
        throw error;
      }
    }
  }

  async close(sessionId: string, ownerUserEntityId: string): Promise<boolean> {
    try {
      await this.#db.send(
        new DeleteCommand({
          TableName: this.#table,
          Key: { sessionId },
          ConditionExpression: 'ownerUserEntityId = :owner',
          ExpressionAttributeValues: { ':owner': ownerUserEntityId },
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

  #expiresAt(lastSeenAt: number): number {
    return Math.floor((lastSeenAt + MCP_SESSION_IDLE_TTL_MS) / 1000);
  }

  /**
   * Drops the owner's least recently used sessions beyond the cap. Two
   * initializes racing may leave the owner one or two over for a moment; the
   * next one trims it, which is all a cap against a looping client needs.
   */
  async #dropOwnOverCap(ownerUserEntityId: string): Promise<string[]> {
    const { Items = [] } = await this.#db.send(
      new QueryCommand({
        TableName: this.#table,
        IndexName: MCP_SESSION_OWNER_INDEX,
        KeyConditionExpression: 'ownerUserEntityId = :owner',
        ExpressionAttributeValues: { ':owner': ownerUserEntityId },
        ProjectionExpression: 'sessionId',
        ScanIndexForward: true,
      })
    );
    const excess = Items.length - this.#maxSessionsPerUser;
    if (excess <= 0) {
      return [];
    }
    const dropped = Items.slice(0, excess).map(
      (item) => (item as Pick<SessionItem, 'sessionId'>).sessionId
    );
    await Promise.all(
      dropped.map((sessionId) =>
        this.#db.send(
          new DeleteCommand({ TableName: this.#table, Key: { sessionId } })
        )
      )
    );
    return dropped;
  }
}
