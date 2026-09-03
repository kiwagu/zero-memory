import { z } from 'zod';

/**
 * The closed set of failure classes every tool and route reports. Closed on
 * purpose: an LLM client can only branch on an error, and a UI can only build
 * an affordance for it, if the vocabulary is small and stable. Anything the
 * caller cannot act on differently belongs under an existing code with a
 * clearer message, not under a new code.
 */
export const errorCodeSchema = z.enum([
  /** The input did not satisfy the tool's schema or its argument rules. */
  'validation_failed',
  /** No usable credentials — the caller has not proven who they are. */
  'unauthorized',
  /** Authenticated, but this actor may not touch this resource. */
  'forbidden',
  /** The named resource does not exist, or is not visible to this actor. */
  'not_found',
  /** The resource exists but its current state forbids the operation. */
  'conflict',
  /** A rate limit or a metered budget is used up; retry later. */
  'rate_limited',
  /** An unexpected server-side failure — nothing the caller can fix. */
  'internal',
]);

export type ErrorCode = z.infer<typeof errorCodeSchema>;

/**
 * The one error body shape. `message` is human/LLM-readable EN prose (the
 * canonical-language rule applies to errors too); `details` is optional
 * structured context — never a stack trace, never anything the caller is not
 * already entitled to see.
 */
export const toolErrorSchema = z.object({
  error: z.object({
    code: errorCodeSchema,
    message: z.string(),
    details: z.unknown().optional(),
  }),
});

export type ToolError = z.infer<typeof toolErrorSchema>;

/**
 * Code → HTTP status, for routes that answer in this taxonomy. It lives beside
 * the enum so the mapping is exhaustive by construction: a new code will not
 * compile until it has a status.
 *
 * Note the routes this does NOT cover: the OAuth endpoints answer in the
 * RFC 6749 shape and `/mcp` answers in JSON-RPC, both mandated by their own
 * specs and both parsed by third-party client libraries.
 */
export const ERROR_CODE_HTTP_STATUS: Record<ErrorCode, number> = {
  validation_failed: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  rate_limited: 429,
  internal: 500,
};

/**
 * Reads a taxonomy code off a thrown value, or null when it carries none.
 *
 * Matches on the `code` property rather than with `instanceof`, for the same
 * reason the domain exceptions do: throw and catch sit in different packages,
 * and `instanceof` across that boundary is only as reliable as the module
 * graph happening to resolve a single copy of the class.
 */
export const errorCodeOf = (error: unknown): ErrorCode | null => {
  if (typeof error !== 'object' || error === null) {
    return null;
  }
  const parsed = errorCodeSchema.safeParse((error as { code?: unknown }).code);
  return parsed.success ? parsed.data : null;
};

/**
 * A failure carrying its taxonomy code, for services that answer with a
 * `Result` instead of throwing.
 *
 * Why a value and not an exception class: the write paths return
 * `Result<T, Failure>`, so the code travels as data from the point that knows
 * the failure class down to the boundary that reports it. Without it the
 * boundary would have to guess a class from prose — the one thing the closed
 * taxonomy exists to prevent — and every caller-fixable rejection would arrive
 * as `internal`, telling an agent "nothing you can do" about a thing it could
 * have fixed by rewording its input.
 */
export interface Failure {
  code: ErrorCode;
  message: string;
}

/** Builds a {@link Failure}. Prefer the named helpers below where one fits. */
export const failure = (code: ErrorCode, message: string): Failure => ({
  code,
  message,
});

/** The input broke a schema or an argument rule — the caller can rewrite it. */
export const validationFailed = (message: string): Failure =>
  failure('validation_failed', message);

/** The named resource does not exist, or is not visible to this actor. */
export const notFound = (message: string): Failure =>
  failure('not_found', message);

/** The resource exists but its state forbids the operation. */
export const conflictFailure = (message: string): Failure =>
  failure('conflict', message);

/** Authenticated, but not allowed to touch this resource. */
export const forbidden = (message: string): Failure =>
  failure('forbidden', message);

/**
 * An unexpected server-side failure. The default for anything unclassified:
 * over-reporting `internal` is safe (the caller retries or reports), while
 * mislabelling a server bug as the caller's fault sends them chasing their own
 * input.
 */
export const internalFailure = (message: string): Failure =>
  failure('internal', message);

/**
 * Turns a {@link Failure} into a thrown error whose `code` {@link errorCodeOf}
 * reads — the bridge for command handlers, which answer by throwing.
 */
export class FailureError extends Error {
  readonly code: ErrorCode;

  constructor(fail: Failure) {
    super(fail.message);
    this.name = 'FailureError';
    this.code = fail.code;
  }
}
