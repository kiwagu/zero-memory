import {
  ERROR_CODE_HTTP_STATUS,
  errorCodeOf,
  type ErrorCode,
  type ToolError,
} from '@workspace/contracts';

/**
 * An HTTP failure answered in the shared error taxonomy: the status comes from
 * the code, the body is the one error shape, so a client branches on
 * `error.code` instead of on prose or on the status alone.
 *
 * Scope note — this is for the routes that answer in OUR vocabulary. It does
 * NOT cover the OAuth endpoints (`register`/`authorize`/`token`), whose bodies
 * are prescribed by RFC 6749, nor the Bearer challenge prescribed by RFC 6750,
 * nor `/mcp`, which answers in JSON-RPC. Those shapes are parsed by
 * third-party client libraries; re-dressing them in this body would break
 * conformance, which after publication is far more expensive than the
 * inconsistency it would tidy up.
 */
export const errorResponse = (
  code: ErrorCode,
  message: string,
  details?: unknown
): Response => {
  const body: ToolError = {
    error: { code, message, ...(details === undefined ? {} : { details }) },
  };
  return new Response(JSON.stringify(body), {
    status: ERROR_CODE_HTTP_STATUS[code],
    headers: { 'content-type': 'application/json' },
  });
};

/**
 * Last-resort answer for a request that threw. A thrown value carrying a
 * taxonomy code keeps its class; anything else is `internal` with a fixed
 * message — an unexpected server-side failure is the one case where the cause
 * stays in the logs (with its request id) rather than going out to the caller.
 */
export const errorResponseFromThrown = (error: unknown): Response => {
  const code = errorCodeOf(error);
  return code === null
    ? errorResponse('internal', 'Internal server error.')
    : errorResponse(
        code,
        error instanceof Error ? error.message : String(error)
      );
};
