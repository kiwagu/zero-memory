import { runWithContext } from '@workspace/context';
import { newRequestId, requestIdSchema } from '@workspace/contracts';
import type { Logger } from '@workspace/logger';

import { errorResponseFromThrown } from './http-error.js';
import { incrementCounter } from './metrics.js';

const REQUEST_ID_HEADER = 'x-request-id';

/**
 * Resolve the correlation id for a request: honor a client-supplied
 * `X-Request-Id` only if it parses as a valid `req_` entity id, otherwise mint
 * a fresh one. Parsing (not trusting) the header keeps ids well-formed and
 * greppable regardless of what a client sends.
 */
export const resolveRequestId = (incoming: string | null): string => {
  if (incoming) {
    const parsed = requestIdSchema.safeParse(incoming);
    if (parsed.success) {
      return parsed.data;
    }
  }
  return newRequestId();
};

/**
 * Wrap a fetch-style handler so every request runs inside a correlation
 * context: the request id is bound in the shared execution context (so deep
 * persistence/extraction logs carry it via the logger's context resolver),
 * echoed back on the response, counted, and summarised in one structured line.
 */
export const withRequestObservability =
  (handler: (request: Request) => Promise<Response>, logger: Logger) =>
  (request: Request): Promise<Response> => {
    const requestId = resolveRequestId(request.headers.get(REQUEST_ID_HEADER));
    const { pathname } = new URL(request.url);
    // Which plugin/watcher version this request came from (client sets it via
    // createAuthedTransport); undefined for callers that don't send it.
    const clientVersion =
      request.headers.get('x-zm-client-version') ?? undefined;
    const startedAt = performance.now();

    return runWithContext({ requestId }, async () => {
      try {
        const response = await handler(request);
        const durationMs = Math.round(performance.now() - startedAt);
        incrementCounter('http_requests_total', {
          status: String(response.status),
        });
        // requestId is added by the logger's context resolver.
        logger.info('http request', {
          method: request.method,
          path: pathname,
          status: response.status,
          duration_ms: durationMs,
          client_version: clientVersion,
        });
        // Rebuild with the correlation header; response headers may be
        // immutable, so never mutate the original in place.
        const headers = new Headers(response.headers);
        headers.set(REQUEST_ID_HEADER, requestId);
        return new Response(response.body, {
          status: response.status,
          statusText: response.statusText,
          headers,
        });
      } catch (error) {
        const durationMs = Math.round(performance.now() - startedAt);
        incrementCounter('http_requests_total', { status: '500' });
        incrementCounter('http_errors_total');
        logger.error('http request failed', {
          method: request.method,
          path: pathname,
          duration_ms: durationMs,
          client_version: clientVersion,
          error: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
        });
        // Answer in the shared error taxonomy so a client can branch on the
        // code; the cause itself stays in the log line above, findable by the
        // request id echoed back here.
        const response = errorResponseFromThrown(error);
        const headers = new Headers(response.headers);
        headers.set(REQUEST_ID_HEADER, requestId);
        return new Response(response.body, {
          status: response.status,
          headers,
        });
      }
    });
  };
