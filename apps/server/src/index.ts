import { createLogger } from '@workspace/logger';
import { Elysia } from 'elysia';

import { createHttpHandler } from './http-handler.js';
import { startHygieneScheduler } from './hygiene-scheduler.js';
import { DynamoDbMcpSessionStore } from './mcp-session.dynamodb-store.js';
import { InMemoryMcpSessionStore } from './mcp-session.memory-store.js';
import type { IMcpSessionStore } from './mcp-session.store.js';
import { startTranslationScheduler } from './translation-scheduler.js';
import { startUsageScheduler } from './usage-scheduler.js';

const logger = createLogger('server');
const port = Number(process.env.PORT ?? 8787);

// Sessions stay in this process unless a session table is named: then they
// live in DynamoDB, which is what a server spread over instances needs (the
// listening server behind the Lambda Web Adapter).
const sessionTable = process.env.ZM_MCP_SESSION_TABLE;
const sessions: IMcpSessionStore = sessionTable
  ? new DynamoDbMcpSessionStore({ tableName: sessionTable })
  : new InMemoryMcpSessionStore();

// A thin outer app owns listening and hands every request to the composed
// handler, which wraps it in the correlation context before the real routes.
// Only the outer app knows the client's socket; the OAuth rate limiter asks
// for it through this callback (the inner app never listens).
const { handle, publicUrl, webUrl } = createHttpHandler({
  port,
  sessions,
  jsonResponse: process.env.ZM_MCP_JSON_RESPONSE === 'on',
  requestIp: () => app.server,
});
// A body larger than this serves no tool or OAuth request; the runtime's own
// default (128 MB) would let one anonymous client fill memory.
const MAX_REQUEST_BODY_BYTES = 4 * 1024 * 1024;
const app = new Elysia()
  .all('*', ({ request }) => handle(request))
  .listen({ port, maxRequestBodySize: MAX_REQUEST_BODY_BYTES });

logger.info('server started', { port, publicUrl, webUrl });

// Optional in-process nightly hygiene scan (independent of the watcher).
startHygieneScheduler();

// Optional in-process nightly language-canonicalization pass (opt-in).
startTranslationScheduler();

// Storage upkeep for the usage ledger. Always on: it costs SQL, not tokens.
startUsageScheduler();

export type { App } from './app.js';
export { app };
