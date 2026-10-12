import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { LambdaClient } from '@aws-sdk/client-lambda';
import { container } from '@workspace/di';
import {
  EMBEDDING_SERVICE,
  type IEmbeddingService,
} from '@workspace/embedding';
import {
  createLogger,
  dispatchBackgroundTo,
  drainDetached,
} from '@workspace/logger';
import { rateLimiterOptionsFromEnv } from '@workspace/mcp-auth';

import { createHttpHandler } from './http-handler.js';
import {
  isDirectInvocation,
  jobsFunctionDispatcher,
  parseJobEvent,
  runJob,
} from './lambda.jobs.js';
import {
  cameThroughEdge,
  EDGE_HEADER,
  edgeSecretFrom,
  forwardedForFromEdge,
  loadRuntimeConfig,
} from './lambda.config.js';
import {
  functionUrlResultFromResponse,
  requestFromFunctionUrlEvent,
  type FunctionUrlEvent,
  type FunctionUrlResult,
} from './lambda.function-url.js';
import { DynamoDbMcpSessionStore } from './mcp-session.dynamodb-store.js';
import { DynamoDbRateLimiter } from './rate-limit.dynamodb-limiter.js';

/**
 * The server as an AWS Lambda function behind a function URL: a custom
 * runtime that pulls invocations from the Lambda Runtime API and hands each
 * one to the same HTTP handler the listening server uses. Sessions live in
 * DynamoDB, because consecutive requests of one session can land on
 * different instances; so does the OAuth rate limiter's count.
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
 *
 * The same runtime serves two direct invocations besides requests: a
 * warm-up, and a timed job (usage upkeep, translation, hygiene) that a
 * scheduler starts on a function of its own with a longer timeout.
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
  // Lambda records only the error type of a failed start; the reason is
  // visible in the function's logs only if the runtime writes it there.
  logger.error('lambda runtime failed to start', { error: message });
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
  const rateLimitTable = process.env.ZM_RATE_LIMIT_TABLE;
  if (!rateLimitTable) {
    throw new Error('ZM_RATE_LIMIT_TABLE must name the rate-limit table.');
  }
  const client = new DynamoDBClient({});
  return createHttpHandler({
    port: Number(process.env.PORT ?? 8787),
    sessions: new DynamoDbMcpSessionStore({ tableName, client }),
    rateLimiter: new DynamoDbRateLimiter({
      tableName: rateLimitTable,
      client,
      ...rateLimiterOptionsFromEnv(),
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
// The value the edge must present; null only where ZM_EDGE_CHECK=off says
// there is no edge (a local emulator).
let edgeSecret: string | null = null;
try {
  handler = await start();
  edgeSecret = edgeSecretFrom(process.env);
  // Behind the edge the instance freezes once it answers, so work started in
  // the background goes to the jobs function. The jobs function itself has
  // no ZM_JOBS_FUNCTION: it runs such work in place, and drains it.
  const jobsFunction = process.env.ZM_JOBS_FUNCTION;
  if (jobsFunction) {
    dispatchBackgroundTo(
      jobsFunctionDispatcher(jobsFunction, new LambdaClient({}))
    );
  }
} catch (error) {
  await reportInitError(error);
}
logger.info('lambda runtime ready', { publicUrl: handler!.publicUrl });

/**
 * The event a deployment sends by invoking the function directly, right after
 * it deployed a new image: the instance loads the embedding model and says
 * how long that took. The first read of a new image's model files is slow
 * (close to a minute measured), and paying it here keeps it off the first
 * search a person makes. Only a caller with AWS credentials can invoke the
 * function directly; anything from the function URL carries `requestContext`.
 *
 * The model is not loaded in the background of ordinary starts: while it
 * loads, the instance answers nothing else on time.
 */
interface WarmUpEvent {
  zeroMemory: 'warm-up';
}

const isWarmUp = (event: unknown): event is WarmUpEvent =>
  typeof event === 'object' &&
  event !== null &&
  !('requestContext' in event) &&
  (event as Partial<WarmUpEvent>).zeroMemory === 'warm-up';

const warmUp = async (): Promise<{ warm: true; duration_ms: number }> => {
  const startedAt = performance.now();
  await container.resolve<IEmbeddingService>(EMBEDDING_SERVICE).warmUp?.();
  const duration_ms = Math.round(performance.now() - startedAt);
  logger.info('embedding model warm', { duration_ms });
  return { warm: true, duration_ms };
};

for (;;) {
  const next = await fetch(`${invocationUrl}/next`);
  const invocationId = next.headers.get('lambda-runtime-aws-request-id');
  const deadline = Number(next.headers.get('lambda-runtime-deadline-ms'));
  const event = (await next.json()) as FunctionUrlEvent | WarmUpEvent;
  try {
    if (isWarmUp(event)) {
      await fetch(`${invocationUrl}/${invocationId}/response`, {
        method: 'POST',
        body: JSON.stringify(await warmUp()),
      });
      continue;
    }
    const job = parseJobEvent(event);
    if (job) {
      const startedAt = performance.now();
      await runJob(job);
      await drainDetached(Math.max(0, deadline - Date.now() - POST_RESERVE_MS));
      const duration_ms = Math.round(performance.now() - startedAt);
      logger.info('job complete', { job: job.job, duration_ms });
      await fetch(`${invocationUrl}/${invocationId}/response`, {
        method: 'POST',
        body: JSON.stringify({ job: job.job, duration_ms }),
      });
      continue;
    }
    if (isDirectInvocation(event)) {
      // Not a request, not a warm-up, not a job this function runs: an
      // invocation error the alarms count, never a quiet answer that would
      // drop handed-off work.
      const asked = (event as { job?: unknown }).job;
      throw new Error(
        `Not a job this function runs: ${typeof asked === 'string' ? asked : 'no job named'} (or its arguments do not match).`
      );
    }
    if (
      edgeSecret !== null &&
      !cameThroughEdge(event.headers?.[EDGE_HEADER], edgeSecret)
    ) {
      await fetch(`${invocationUrl}/${invocationId}/response`, {
        method: 'POST',
        body: JSON.stringify(notFromEdge),
      });
      continue;
    }
    // The shared value is the edge's business only; the server never sees it.
    delete event.headers?.[EDGE_HEADER];
    if (edgeSecret !== null && event.headers) {
      forwardedForFromEdge(event.headers);
    }
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
