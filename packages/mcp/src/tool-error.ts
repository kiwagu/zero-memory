import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import {
  errorCodeOf,
  type ErrorCode,
  type ToolError,
} from '@workspace/contracts';

/**
 * The single way a tool reports failure.
 *
 * The body is the taxonomy shape serialized as the first text block, mirroring
 * how successful results travel: callers already read block 0 as JSON, so an
 * agent can branch on `error.code` and a UI can build an affordance for it,
 * instead of pattern-matching English prose that changes with every reword.
 */
export const toolError = (
  code: ErrorCode,
  message: string,
  details?: unknown
): CallToolResult => {
  const body: ToolError = {
    error: { code, message, ...(details === undefined ? {} : { details }) },
  };
  return {
    isError: true,
    content: [{ type: 'text', text: JSON.stringify(body, null, 2) }],
  };
};

/**
 * Reports a thrown value. A domain exception carrying a taxonomy `code` keeps
 * its class; anything else is `internal` — an unexpected failure the caller
 * cannot act on differently, so guessing a friendlier code would only mislead.
 * The message is passed through rather than redacted: these tools answer their
 * own owner, and a swallowed cause is a debugging dead end.
 */
export const toolErrorFromThrown = (error: unknown): CallToolResult =>
  toolError(
    errorCodeOf(error) ?? 'internal',
    error instanceof Error ? error.message : String(error)
  );
