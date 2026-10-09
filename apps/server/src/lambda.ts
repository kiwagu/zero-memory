import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { createLogger, drainDetached } from '@workspace/logger';

import { createHttpHandler } from './http-handler.js';
import {
  cameThroughEdge,
  EDGE_HEADER,
  loadRuntimeConfig,
} from './lambda.config.js';
import {
  functionUrlResultFromResponse,
  requestFromFunctionUrlEvent,
  type FunctionUrlEvent,
  type FunctionUrlResult,
} from './lambda.function-url.js';
import { DynamoDbMcpSessionStore } from './mcp-session.dynamodb-store.js';

/**
 * The server as an AWS Lambda function behind a function URL: a custom
 * runtime that pulls invocations from the Lambda Runtime API and hands each
 * one to the same HTTP handler the listening server uses. Sessions live in
 * DynamoDB, because consecutive requests of one session can land on
 * different instances.
 *
 * Lambda freezes the process as soon as a response is posted, so the side
 * writes started during the request (metering, audit, the session's project)
 * are drained first; an instance that is recycled while frozen would lose
 * them otherwise.
 *
 * Configuration that cannot sit on the function itself (secrets, the edge's
 * own address) is loaded once per instance before the server is composed,
 * and a request that did not come through the edge is refused before it
 * reaches the server.
 */

const logger = createLogger('lambda');
const runtimeApi = process.env.AWS_LAMBDA_RUNTIME_API;
if (!runtimeApi) {
  throw new Error('AWS_LAMBDA_RUNTIME_API is not set: not running in Lambda.');
}
const invocationUrl = `http://${runtimeApi}/2018-06-01/runtime/invocation`;

/** Keep this much of the invocation's time for posting the response. */
const POST_RESERVE_MS = 500;

const reportInitError = async (error: unknown): Promise<never> => {
  const message = error instanceof Error ? error.message : String(error);
  await fetch(`http://${runtimeApi}/2018-06-01/runtime/init/error`, {
    method: 'POST',
    headers: { 'lambda-runtime-function-error-type': 'Runtime.InitError' },
    body: JSON.stringify({ errorMessage: message, errorType: 'InitError' }),
  });
  process.exit(1);
};

const sourceIps = new WeakMap<Request, string>();

const start = async (): Promise<ReturnType<typeof createHttpHandler>> => {
  await loadRuntimeConfig();
  const tableName = process.env.ZM_MCP_SESSION_TABLE;
  if (!tableName) {
    throw new Error('ZM_MCP_SESSION_TABLE must name the session table.');
  }
  return createHttpHandler({
    port: Number(process.env.PORT ?? 8787),
    sessions: new DynamoDbMcpSessionStore({
      tableName,
      client: new DynamoDBClient({}),
    }),
    jsonResponse: process.env.ZM_MCP_JSON_RESPONSE === 'on',
    // Behind CloudFront the viewer's address arrives in X-Forwarded-For
    // (ZM_TRUST_PROXY); the caller's own address is the fallback.
    requestIp: () => ({
      requestIP: (request: Request) => {
        const address = sourceIps.get(request);
        return address ? { address } : null;
      },
    }),
  });
};

const notFromEdge: FunctionUrlResult = {
  statusCode: 403,
  headers: { 'content-type': 'text/plain' },
  body: 'Forbidden',
  isBase64Encoded: false,
};

let handler: ReturnType<typeof createHttpHandler>;
try {
  handler = await start();
} catch (error) {
  await reportInitError(error);
}
logger.info('lambda runtime ready', { publicUrl: handler!.publicUrl });

for (;;) {
  const next = await fetch(`${invocationUrl}/next`);
  const invocationId = next.headers.get('lambda-runtime-aws-request-id');
  const deadline = Number(next.headers.get('lambda-runtime-deadline-ms'));
  const event = (await next.json()) as FunctionUrlEvent;
  try {
    const presented = event.headers?.[EDGE_HEADER];
    if (!cameThroughEdge(presented, process.env.ZM_ORIGIN_VERIFY)) {
      await fetch(`${invocationUrl}/${invocationId}/response`, {
        method: 'POST',
        body: JSON.stringify(notFromEdge),
      });
      continue;
    }
    // The shared value is the edge's business only; the server never sees it.
    delete event.headers?.[EDGE_HEADER];
    const request = requestFromFunctionUrlEvent(event);
    sourceIps.set(request, event.requestContext.http.sourceIp);
    const response = await handler!.handle(request);
    const result = await functionUrlResultFromResponse(response);
    const pending = await drainDetached(
      Math.max(0, deadline - Date.now() - POST_RESERVE_MS)
    );
    if (pending > 0) {
      logger.warn('side writes still pending when the response went out', {
        pending,
      });
    }
    await fetch(`${invocationUrl}/${invocationId}/response`, {
      method: 'POST',
      body: JSON.stringify(result),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error('invocation failed', { error: message });
    await fetch(`${invocationUrl}/${invocationId}/error`, {
      method: 'POST',
      headers: { 'lambda-runtime-function-error-type': 'Runtime.HandlerError' },
      body: JSON.stringify({
        errorMessage: message,
        errorType: 'HandlerError',
      }),
    });
  }
}
