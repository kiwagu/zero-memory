import type { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { dynamoDbTestTables } from './dynamodb.test-tables.js';
import { DynamoDbMcpSessionStore } from './mcp-session.dynamodb-store.js';
import {
  MCP_SESSION_IDLE_TTL_MS,
  type McpSessionRecord,
} from './mcp-session.store.js';

let client: DynamoDBClient;
let tableName: string;

beforeAll(async () => {
  const tables = await dynamoDbTestTables();
  client = tables.client;
  tableName = tables.names.sessions;
});

afterEach(() => {
  delete process.env.ZM_MAX_SESSIONS_PER_USER;
});

const store = () => new DynamoDbMcpSessionStore({ tableName, client });

const record = (
  ownerUserEntityId: string,
  lastSeenAt: number
): McpSessionRecord => ({
  sessionId: `ses_${crypto.randomUUID()}`,
  ownerUserEntityId,
  clientName: 'spec-client',
  lastSeenAt,
});

describe('DynamoDbMcpSessionStore against DynamoDB Local', () => {
  it('resumes a session for its owner on another store, as on another instance', async () => {
    const owner = `usr_${crypto.randomUUID()}`;
    const opened = record(owner, Date.now());
    await store().open(opened);
    await store().attachScope(opened.sessionId, 'proj.owner.repo');

    const resumed = await store().resume(
      opened.sessionId,
      owner,
      opened.lastSeenAt + 1000
    );
    expect(resumed).toEqual({
      ...opened,
      defaultScope: 'proj.owner.repo',
      lastSeenAt: opened.lastSeenAt + 1000,
    });
  });

  it('refuses another user, an idle session and a closed one', async () => {
    const owner = `usr_${crypto.randomUUID()}`;
    const opened = record(owner, Date.now());
    await store().open(opened);

    expect(
      await store().resume(opened.sessionId, 'usr_someone_else', Date.now())
    ).toBeUndefined();
    expect(
      await store().resume(
        opened.sessionId,
        owner,
        opened.lastSeenAt + MCP_SESSION_IDLE_TTL_MS + 1000
      )
    ).toBeUndefined();

    expect(await store().close(opened.sessionId, 'usr_someone_else')).toBe(
      false
    );
    expect(await store().close(opened.sessionId, owner)).toBe(true);
    expect(
      await store().resume(opened.sessionId, owner, Date.now())
    ).toBeUndefined();
  });

  it("drops the owner's least recently used sessions beyond the cap", async () => {
    process.env.ZM_MAX_SESSIONS_PER_USER = '2';
    const owner = `usr_${crypto.randomUUID()}`;
    const now = Date.now();
    const [oldest, middle, newest] = [0, 1, 2].map((i) =>
      record(owner, now + i * 1000)
    ) as [McpSessionRecord, McpSessionRecord, McpSessionRecord];

    expect(await store().open(oldest)).toEqual([]);
    expect(await store().open(middle)).toEqual([]);
    expect(await store().open(newest)).toEqual([oldest.sessionId]);
    expect(
      await store().resume(oldest.sessionId, owner, now + 5000)
    ).toBeUndefined();
    expect(
      await store().resume(newest.sessionId, owner, now + 5000)
    ).toBeDefined();
  });
});
